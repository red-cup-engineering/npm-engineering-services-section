#!/usr/bin/env node
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { projectNpmPackageInfo } from "@red-cup-engineering/npm-package-services-section/project-npm-package-info";
import { readNpmPackageManifest } from "@red-cup-engineering/npm-package-services-section/read-npm-package-manifest";

import operationInputSchema from "../data/records/read-npm-package-info.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/read-npm-package-info.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Reads selected information from one explicit npm package directory.
 * @param {object} request An NpmPackageInfoReadRequest@1.
 * @returns {Promise<object>} An immutable NpmPackageInfoRead@1.
 */
export async function readNpmPackageInfo(request) {
  if (
    !isJsonRecord(request)
    || Object.keys(request).sort().join(",") !== "directory,keys,type,version"
    || request.type !== "NpmPackageInfoReadRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmPackageInfoReadRequest@1");
  }

  const manifestRead = await readNpmPackageManifest({
    type: "NpmPackageManifestReadRequest",
    version: 1,
    directory: request.directory,
  });
  const projection = projectNpmPackageInfo({
    type: "NpmPackageInfoProjectionRequest",
    version: 1,
    manifest: manifestRead.manifest,
    keys: request.keys,
  });
  return freezeJson({
    type: "NpmPackageInfoRead",
    version: 1,
    directory: request.directory,
    path: manifestRead.path,
    info: projection.info,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "read-npm-package-info", description: "Reads selected information from one explicit npm package directory.", operation: readNpmPackageInfo, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
