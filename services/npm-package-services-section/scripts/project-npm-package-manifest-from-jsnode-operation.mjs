#!/usr/bin/env node
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";
import { admitTextFileCreationProjection } from "@red-cup-engineering/computer-file-engineering-services-section/admit-text-file-creation-projection";

function requireSpecification(value) {
  if (value?.type !== "JsnodeOperationPackageSpecification" || value.version !== 1) {
    throw new TypeError("input must be an admitted JsnodeOperationPackageSpecification@1");
  }
  return value;
}

/**
 * Projects the npm manifest face of one admitted JSNode operation package.
 *
 * @param {object} specification An admitted JsnodeOperationPackageSpecification.
 * @returns {object} A package.json TextFileCreationProjection.
 */
export function projectNpmPackageManifestFromJsnodeOperation(specification) {
  const admitted = requireSpecification(specification);
  const operationTarget = `./${admitted.operation.path}`;
  const manifest = {
    name: admitted.packageName,
    version: admitted.packageVersion,
    description: admitted.operation.documentation.description,
    type: "module",
    private: false,
    license: admitted.license,
    exports: operationTarget,
    bin: { [admitted.operation.commandName]: admitted.operation.path },
    files: ["scripts", "README.md", "package.json"],
    dependencies: admitted.dependencies,
    devDependencies: admitted.devDependencies,
    scripts: {
      check: `node --check ${admitted.operation.path}`,
      test: "node --test test/*.test.mjs",
      "pack:dry-run": "npm pack --dry-run --ignore-scripts",
    },
    engines: { node: ">=24.2.0" },
  };
  const projection = admitTextFileCreationProjection({
    type: "TextFileCreationProjection",
    version: 1,
    path: "package.json",
    text: `${JSON.stringify(manifest, null, 2)}\n`,
    mode: 0o644,
  });
  if (projection.type !== "TextFileCreationProjection") {
    throw new TypeError(`admitted manifest produced ${projection.code}: ${projection.message}`);
  }
  return projection;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({
    name: "project-npm-package-manifest-from-jsnode-operation",
    description: "Projects the npm manifest face of one admitted JSNode operation package.",
    operation: projectNpmPackageManifestFromJsnodeOperation,
  }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
