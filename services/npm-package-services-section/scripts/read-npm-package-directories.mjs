#!/usr/bin/env node
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { selectNpmPackageManifestPaths } from "@red-cup-engineering/computer-filepath-engineering-services-section/select-npm-package-manifest-paths";
import { walkPosixPaths } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { pathParent as projectFilepathDirectory } from "@red-cup-engineering/computer-filepath-engineering-services-section/posix";

import { projectRegularFilePaths } from "@red-cup-engineering/computer-file-engineering-services-section/project-regular-file-paths";
import { resolve } from "node:path";

import operationInputSchema from "../data/records/read-npm-package-directories.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/read-npm-package-directories.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Reads npm package directories beneath one explicit filesystem root.
 * @param {object} request An NpmPackageDirectoriesReadRequest@1.
 * @returns {Promise<object>} An immutable NpmPackageDirectoriesRead@1.
 */
export async function readNpmPackageDirectories(request) {
  if (
    !isJsonRecord(request)
    || Object.keys(request).sort().join(",") !== "excludes,root,type,version"
    || request.type !== "NpmPackageDirectoriesReadRequest"
    || request.version !== 1
    || typeof request.root !== "string"
    || request.root.length === 0
    || !Array.isArray(request.excludes)
    || request.excludes.some((segment) => typeof segment !== "string" || segment.length === 0)
  ) {
    throw new TypeError("request must be an exact NpmPackageDirectoriesReadRequest@1");
  }

  const walk = await walkPosixPaths({ root: request.root, excludes: request.excludes });
  const selection = selectNpmPackageManifestPaths({
    type: "NpmPackageManifestPathSelectionRequest",
    version: 1,
    paths: projectRegularFilePaths(walk),
  });
  const directories = selection.paths.map((manifestPath) => ({
    type: "NpmPackageDirectory",
    version: 1,
    path: resolve(walk.root, projectFilepathDirectory(manifestPath)),
  }));
  return freezeJson({
    type: "NpmPackageDirectoriesRead",
    version: 1,
    root: walk.root,
    directories,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "read-npm-package-directories", description: "Reads npm package directories beneath one explicit filesystem root.", operation: readNpmPackageDirectories, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
