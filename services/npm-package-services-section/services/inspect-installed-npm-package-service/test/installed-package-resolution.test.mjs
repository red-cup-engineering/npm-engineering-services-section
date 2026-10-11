import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectInstalledNpmPackage, inspectInstalledNpmPackageResolution } from "../scripts/inspect-installed-npm-package.mjs";

async function fixture(t, version = "1.0.0") {
  const projectRoot = await mkdtemp(join(tmpdir(), "installed-resolution-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const packageRoot = join(projectRoot, "node_modules/@test/hidden");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({ private: true, dependencies: { "@test/hidden": "2.0.0" } }));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@test/hidden", version, type: "module", exports: { ".": { import: "./index.mjs" } } }));
  await writeFile(join(packageRoot, "index.mjs"), 'throw new Error("resolution must not execute module");');
  return { type: "InstalledNpmPackageInspectionRequest", version: 1, projectRoot, packageRoot, expectedName: "@test/hidden", expectedVersion: "2.0.0" };
}

test("declared version 2 cannot pass with installed version 1 despite a current source manifest", async (t) => {
  const request = await fixture(t);
  const source = join(request.projectRoot, "source");
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@test/hidden", version: "2.0.0" }));
  const read = await inspectInstalledNpmPackage({ ...request, packageRoot: source });
  assert.equal(read.conformant, false);
  assert.equal(read.resolution.packageVersion, "1.0.0");
  assert.equal(read.resolution.packageRoot, request.packageRoot);
  assert.equal(read.resolution.entryPath, join(request.packageRoot, "index.mjs"));
  assert.ok(read.defects.some((defect) => defect.law === "installed-identity"));
  assert.ok(read.defects.some((defect) => defect.law === "installed-resolution-path"));
});

test("exact installed version passes with hidden package.json exports and without executing code", async (t) => {
  const request = await fixture(t, "2.0.0");
  const read = await inspectInstalledNpmPackageResolution({ ...request, packageRoot: null });
  assert.equal(read.conformant, true);
  assert.equal(read.packageVersion, "2.0.0");
  assert.equal(read.packageRoot, request.packageRoot);
});

test("missing installation is a structured refusal", async (t) => {
  const request = await fixture(t);
  await rm(request.packageRoot, { recursive: true });
  const read = await inspectInstalledNpmPackageResolution(request);
  assert.equal(read.conformant, false);
  assert.equal(read.packageVersion, null);
  assert.equal(read.defects[0].law, "installed-package-resolution");
  assert.match(read.defects[0].diagnostic, /Cannot find package/u);
});

test("returned spawn.error stays visible even when status reports zero", async (t) => {
  const request = await fixture(t);
  const read = await inspectInstalledNpmPackageResolution(request, { execute: async () => ({ status: 0, stdout: "", error: Object.assign(new Error("spawn denied"), { code: "EPERM" }) }) });
  assert.equal(read.conformant, false);
  assert.equal(read.defects[0].spawnError, "spawn denied");
  assert.equal(read.defects[0].code, "EPERM");
});

test("an inexact expected version cannot become acceptance evidence", async (t) => {
  const request = await fixture(t);
  await assert.rejects(inspectInstalledNpmPackageResolution({ ...request, expectedVersion: "^2.0.0" }), /exact version/u);
});

test("the CLI refuses stale execution identity with a nonzero exit and structured output", async (t) => {
  const request = await fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/inspect-installed-npm-package.mjs", import.meta.url))], {
    input: JSON.stringify(request) + "\n", encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).resolution.packageVersion, "1.0.0");
  assert.equal(JSON.parse(result.stdout).conformant, false);
});
