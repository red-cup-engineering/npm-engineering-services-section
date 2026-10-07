import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectNpmPackageManifestWithIdentity } from "../scripts/project-npm-package-manifest-with-identity.mjs";

const request = {
  type: "NpmPackageManifestIdentityProjectionRequest",
  version: 1,
  manifest: { private: false, description: "kept" },
  name: "@scope/name",
  packageVersion: "1.2.3",
};

test("projects identity without repairing unrelated manifest fields", () => {
  assert.deepEqual(projectNpmPackageManifestWithIdentity(request), {
    type: "NpmPackageManifest",
    version: 1,
    manifest: {
      private: false,
      description: "kept",
      name: "@scope/name",
      version: "1.2.3",
    },
  });
});

test("refuses identity that would need repair", () => {
  assert.throws(
    () => projectNpmPackageManifestWithIdentity({ ...request, packageVersion: "workspace:*" }),
    TypeError,
  );
  assert.throws(
    () => projectNpmPackageManifestWithIdentity({ ...request, name: "@Scope/name" }),
    TypeError,
  );
});

test("the command maps the same projection over NDJSON", () => {
  const script = fileURLToPath(new URL("../scripts/project-npm-package-manifest-with-identity.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), projectNpmPackageManifestWithIdentity(request));
});
