import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectInstalledNpmPackage, inspectInstalledNpmPackageResolution } from "../scripts/inspect-installed-npm-package.mjs";

async function fixture(t, manifest, files) {
  const projectRoot = await mkdtemp("/tmp/installed-faces-");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const packageRoot = join(projectRoot, "node_modules/@test/faces");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@test/faces", version: "2.0.0", type: "module", ...manifest }));
  for (const [file, text] of Object.entries(files)) { await mkdir(join(packageRoot, file, ".."), { recursive: true }); await writeFile(join(packageRoot, file), text); }
  return { type: "InstalledNpmPackageInspectionRequest", version: 1, packageRoot, projectRoot, expectedName: "@test/faces", expectedVersion: "2.0.0" };
}

async function bin(request, name, target) {
  await mkdir(join(request.projectRoot, "node_modules/.bin"), { recursive: true });
  await chmod(join(request.packageRoot, target), 0o755);
  await symlink(join(request.packageRoot, target), join(request.projectRoot, "node_modules/.bin", name));
}

test("bin-only inspection passes without inventing a root import or executing the command", async t => {
  const request = await fixture(t, { bin: { serve: "./server.mjs" } }, { "server.mjs": '#!/usr/bin/env node\nthrow new Error("must not launch server");' });
  await bin(request, "serve", "server.mjs");
  const read = await inspectInstalledNpmPackage(request);
  assert.equal(read.conformant, true, JSON.stringify(read.defects));
  const selected = await inspectInstalledNpmPackageResolution({ ...request, entry: { kind: "bin", name: "serve" } });
  assert.equal(selected.entryPath, join(request.packageRoot, "server.mjs"));
  assert.equal(selected.conformant, true);
  assert.equal((await inspectInstalledNpmPackageResolution(request)).conformant, false, "omitted entry still requests root import");
});

test("bin-only stale identity and a misdirected executable link remain refusals", async t => {
  const request = await fixture(t, { bin: { serve: "./server.mjs" } }, { "server.mjs": "#!/usr/bin/env node\n", "wrong.mjs": "#!/usr/bin/env node\n" });
  await bin(request, "serve", "wrong.mjs");
  const stale = await inspectInstalledNpmPackage({ ...request, expectedVersion: "3.0.0" });
  assert.ok(stale.defects.some(x => x.law === "installed-identity"));
  const broken = await inspectInstalledNpmPackage(request);
  assert.ok(broken.defects.some(x => x.law === "installed-bin-link"));
});

test("subpath-only package identity and explicitly selected import use the actual hidden manifest", async t => {
  const request = await fixture(t, { exports: { "./operation": { import: "./operation.mjs" } } }, { "operation.mjs": "export const value = 42;" });
  assert.equal((await inspectInstalledNpmPackage(request)).conformant, true);
  const read = await inspectInstalledNpmPackageResolution({ ...request, packageRoot: null, entry: { kind: "import", specifier: "@test/faces/operation" } });
  assert.equal(read.packageVersion, "2.0.0"); assert.equal(read.entryPath, join(request.packageRoot, "operation.mjs"));
  assert.equal((await inspectInstalledNpmPackageResolution(request)).conformant, false);
});

test("JSON export aliases receive attributes from the resolved target and malformed JSON still fails", async t => {
  const request = await fixture(t, { exports: { "./configuration": "./config.json" } }, { "config.json": '{"enabled":true}' });
  assert.equal((await inspectInstalledNpmPackage(request)).conformant, true);
  await writeFile(join(request.packageRoot, "config.json"), "{bad");
  const read = await inspectInstalledNpmPackage(request);
  assert.ok(read.defects.some(x => x.law === "declared-import-runtime" && x.specifier === "@test/faces/configuration"));
});

test("absent declared JavaScript, undeclared dependencies, and node_modules TypeScript remain visible", async t => {
  const request = await fixture(t, { exports: { "./missing": "./missing.mjs", "./typed": "./typed.mts", "./dependency": "./dependency.mjs" } }, { "typed.mts": "export const value: number = 1;", "dependency.mjs": 'import "absent-dependency";' });
  const read = await inspectInstalledNpmPackage(request);
  assert.ok(read.defects.some(x => x.law === "installed-face-target" && x.target === "./missing.mjs"));
  assert.ok(read.defects.some(x => x.law === "declared-import-runtime" && x.specifier.endsWith("/typed")));
  assert.ok(read.defects.some(x => x.law === "runtime-dependency-declaration" && x.dependency === "absent-dependency"));
});

test("explicit import selection cannot escape package identity or accept unknown import attributes", async t => {
  const request = await fixture(t, { exports: "./entry.mjs" }, { "entry.mjs": "export const value = 1;" });
  await assert.rejects(inspectInstalledNpmPackageResolution({ ...request, entry: { kind: "import", specifier: "another-package" } }), /entry/);
  await assert.rejects(inspectInstalledNpmPackageResolution({ ...request, projectRoot: null, entry: { kind: "import", specifier: "@test/faces" } }), /consumer projectRoot/);
  assert.equal((await inspectInstalledNpmPackageResolution({ ...request, projectRoot: null })).conformant, true, "omitted entry retains packageRoot-only identity inspection");
  await assert.rejects(inspectInstalledNpmPackageResolution({ ...request, entry: { kind: "import", specifier: "@test/faces", attributes: { type: "css" } } }), /entry/);
});
