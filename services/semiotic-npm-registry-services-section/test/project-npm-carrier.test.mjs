import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { carrierProjectionExclusions, projectNpmCarrier } from "../scripts/project-npm-carrier.mjs";

test("projects the controlled carrier, excludes non-release territories, nested packages, and replaces the root manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-carrier-projection-"));
  try {
    const source = join(root, "source"), target = join(root, "target");
    await mkdir(join(source, "src", "nested"), { recursive: true });
    await mkdir(join(source, "content", "contracts"), { recursive: true });
    await mkdir(join(source, "content", "exchanges"), { recursive: true });
    await mkdir(join(source, "data"), { recursive: true });
    await mkdir(join(source, "node_modules", "outside"), { recursive: true });
    await writeFile(join(source, "package.json"), '{"name":"@customer/source","x-house":"remove"}\n');
    await writeFile(join(source, "src", "index.mjs"), "export const carrier = true;\n");
    await writeFile(join(source, "src", "nested", "package.json"), '{"name":"@customer/nested"}\n');
    await writeFile(join(source, "src", "nested", "index.mjs"), "export const nested = true;\n");
    await writeFile(join(source, "content", "contracts", "law.rml"), "(map)\n");
    await writeFile(join(source, "content", "exchanges", "instance.json"), "{}\n");
    await writeFile(join(source, "data", "private.json"), "{}\n");
    await writeFile(join(source, "node_modules", "outside", "index.js"), "module.exports = false;\n");

    const manifest = { name: "@customer/source", version: "1.0.0", exports: "./src/index.mjs" };
    await projectNpmCarrier({ sourceDirectory: source, targetDirectory: target, manifest, rewriteManifest: true });

    assert.deepEqual(JSON.parse(await readFile(join(target, "package.json"), "utf8")), manifest);
    assert.equal(await readFile(join(target, "src", "index.mjs"), "utf8"), "export const carrier = true;\n");
    assert.equal(await readFile(join(target, "content", "contracts", "law.rml"), "utf8"), "(map)\n");
    await assert.rejects(() => lstat(join(target, "src", "nested")), { code: "ENOENT" });
    await assert.rejects(() => lstat(join(target, "content", "exchanges")), { code: "ENOENT" });
    await assert.rejects(() => lstat(join(target, "data")), { code: "ENOENT" });
    await assert.rejects(() => lstat(join(target, "node_modules")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses symbolic links and overlapping projection territories", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-carrier-projection-refusal-"));
  try {
    const source = join(root, "source"), outside = join(root, "outside"), target = join(root, "target");
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(source, "package.json"), '{"name":"@customer/source"}\n');
    await writeFile(join(outside, "secret.txt"), "do not carry\n");
    await symlink(outside, join(source, "escape"));
    await assert.rejects(
      () => projectNpmCarrier({ sourceDirectory: source, targetDirectory: target }),
      /refused symbolic link: \/escape/u,
    );
    await assert.rejects(
      () => projectNpmCarrier({ sourceDirectory: source, targetDirectory: join(source, "projection") }),
      /must not overlap/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes its exclusions as an inspectable boundary contract", () => {
  assert.deepEqual(carrierProjectionExclusions.directoryNames, [".archive", ".git", ".tmp", "cache", "data", "node_modules", "test", "tests"]);
  assert.deepEqual(carrierProjectionExclusions.pathSegments, [
    "/content/assets/legacy/", "/content/dispatches/", "/content/exchanges/", "/content/packets/", "/content/proposals/", "/content/requirement-events/", "/content/retired-carriers/", "/content/runtime/", "/content/tasks/",
  ]);
  assert.equal(carrierProjectionExclusions.nestedPackageTerritories, true);
  assert.equal(carrierProjectionExclusions.symbolicLinks, "refused");
});
