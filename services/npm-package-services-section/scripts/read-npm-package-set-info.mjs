#!/usr/bin/env node
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";

import { readNpmPackageDirectories } from "@red-cup-engineering/npm-package-services-section/read-npm-package-directories";
import { readNpmPackageInfo } from "@red-cup-engineering/npm-package-services-section/read-npm-package-info";

import operationInputSchema from "../data/records/read-npm-package-set-info.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/read-npm-package-set-info.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Reads selected information from every npm package directory beneath one root.
 * @param {object} request An NpmPackageSetInfoReadRequest@1.
 * @returns {Promise<object>} An immutable NpmPackageSetInfoRead@1.
 */
export async function readNpmPackageSetInfo(request) {
  if (
    !isJsonRecord(request)
    || Object.keys(request).sort().join(",") !== "excludes,keys,root,type,version"
    || request.type !== "NpmPackageSetInfoReadRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmPackageSetInfoReadRequest@1");
  }
  const directoriesRead = await readNpmPackageDirectories({
    type: "NpmPackageDirectoriesReadRequest",
    version: 1,
    root: request.root,
    excludes: request.excludes,
  });
  const packages = await Promise.all(directoriesRead.directories.map((directory) => readNpmPackageInfo({
    type: "NpmPackageInfoReadRequest",
    version: 1,
    directory,
    keys: request.keys,
  })));
  return freezeJson({
    type: "NpmPackageSetInfoRead",
    version: 1,
    root: directoriesRead.root,
    packages,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "read-npm-package-set-info", description: "Reads selected information from every npm package directory beneath one root.", operation: readNpmPackageSetInfo, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
