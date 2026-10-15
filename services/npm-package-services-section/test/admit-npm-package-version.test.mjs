import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { admitNpmPackageVersion } from "@red-cup-engineering/npm-package-version-admission-service";

test("admits exact numeric and prerelease SemVer versions unchanged", () => {
  assert.equal(admitNpmPackageVersion("12.3.0"), "12.3.0");
  assert.equal(admitNpmPackageVersion("0.5.0-dev.0"), "0.5.0-dev.0");
  assert.equal(admitNpmPackageVersion("1.2.3-rc.1+build.7"), "1.2.3-rc.1+build.7");
});

test("refuses missing, inferred, padded, ranged, and malformed versions", () => {
  for (const value of [undefined, "", "1.2", "01.2.3", "1.2.3-01", "1.2.3+", "^1.2.3", "workspace:*"]) {
    assert.throws(() => admitNpmPackageVersion(value), TypeError);
  }
});

test("the command maps the same admission over NDJSON", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("@red-cup-engineering/npm-package-version-admission-service", import.meta.url))], {
    input: `${JSON.stringify("12.3.0")}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), admitNpmPackageVersion("12.3.0"));
});
