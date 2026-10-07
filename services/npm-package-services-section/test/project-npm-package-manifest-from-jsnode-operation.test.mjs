import assert from "node:assert/strict";
import test from "node:test";
import { projectNpmPackageManifestFromJsnodeOperation } from "../scripts/project-npm-package-manifest-from-jsnode-operation.mjs";

test("projects one manifest whose export and command address the same operation file", () => {
  const projection = projectNpmPackageManifestFromJsnodeOperation({
    type: "JsnodeOperationPackageSpecification",
    version: 1,
    packageName: "@red-cup-engineering/example-service",
    packageVersion: "0.1.0",
    license: "MIT",
    operation: {
      path: "scripts/example.mjs",
      commandName: "example",
      documentation: { description: "Does the example." },
    },
    dependencies: { "some-runtime": "1.2.3" },
    devDependencies: {},
  });
  const manifest = JSON.parse(projection.text);
  assert.equal(projection.path, "package.json");
  assert.equal(projection.mode, 0o644);
  assert.equal(manifest.exports, "./scripts/example.mjs");
  assert.deepEqual(manifest.bin, { example: "scripts/example.mjs" });
  assert.deepEqual(manifest.dependencies, { "some-runtime": "1.2.3" });
  assert.equal(manifest.scripts.check, "node --check scripts/example.mjs");
  assert.equal(manifest.scripts.test, "node --test test/*.test.mjs");
  assert.equal(manifest.scripts["pack:dry-run"], "npm pack --dry-run --ignore-scripts");
  assert.equal(Object.hasOwn(manifest.scripts, "verify"), false);
  assert.equal(manifest.engines.node, ">=24.2.0");
});
