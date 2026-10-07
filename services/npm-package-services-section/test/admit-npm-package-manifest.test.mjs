import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { admitNpmPackageManifest } from "../scripts/admit-npm-package-manifest.mjs";

const manifest = {
  name: "@scope/example",
  version: "1.2.3",
  private: false,
  scripts: { test: "node --test" },
};
const candidate = { type: "NpmPackageManifestCandidate", version: 1, manifest };

test("admits and preserves a complete manifest", () => {
  assert.deepEqual(admitNpmPackageManifest(candidate), {
    type: "NpmPackageManifest",
    version: 1,
    manifest,
  });
});

test("refuses values that would require repair", () => {
  for (const rejected of [
    { name: "@Scope/example" },
    { version: "workspace:*" },
    { scripts: { test: 3 } },
  ]) {
    assert.throws(
      () => admitNpmPackageManifest({ ...candidate, manifest: rejected }),
      TypeError,
    );
  }
});

test("the command maps the same admission over NDJSON", () => {
  const script = fileURLToPath(new URL("../scripts/admit-npm-package-manifest.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(candidate)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), admitNpmPackageManifest(candidate));
});
