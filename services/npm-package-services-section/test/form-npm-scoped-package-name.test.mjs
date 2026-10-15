import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formNpmScopedPackageName } from "@red-cup-engineering/npm-scoped-package-name-formation-service";

const request = {
  type: "NpmScopedPackageNameFormationRequest",
  version: 1,
  owner: "example",
  leaf: "thing-service",
};

test("forms a scoped npm package name from already admitted parts", () => {
  assert.equal(formNpmScopedPackageName(request), "@example/thing-service");
});

test("refuses parts that would require repair", () => {
  assert.throws(
    () => formNpmScopedPackageName({ ...request, owner: "@Example" }),
    TypeError,
  );
});

test("the command maps the same formation over NDJSON", () => {
  const script = fileURLToPath(new URL("@red-cup-engineering/npm-scoped-package-name-formation-service", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), formNpmScopedPackageName(request));
});
