import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { admitNpmPackageNameLeaf } from "@red-cup-engineering/npm-package-name-leaf-admission-service";

test("admits a valid lowercase npm package-name leaf", () => {
  assert.equal(admitNpmPackageNameLeaf("thing-service"), "thing-service");
});

test("refuses package-name leaves that would require repair", () => {
  for (const candidate of ["Thing", "", "-thing", "thing-"]) {
    assert.throws(() => admitNpmPackageNameLeaf(candidate), /canonical lowercase/u);
  }
});

test("the command maps the same admission over NDJSON", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("@red-cup-engineering/npm-package-name-leaf-admission-service", import.meta.url))], {
    input: `${JSON.stringify("thing-service")}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), admitNpmPackageNameLeaf("thing-service"));
});
