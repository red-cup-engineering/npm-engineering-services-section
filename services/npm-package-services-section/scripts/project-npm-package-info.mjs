#!/usr/bin/env node
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { projectJsonRecordKeys } from "@red-cup-engineering/json-services-section/project-json-record-keys";

import operationInputSchema from "../data/records/project-npm-package-info.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/project-npm-package-info.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Projects explicitly selected keys from an admitted npm package manifest.
 * @param {object} request An NpmPackageInfoProjectionRequest@1.
 * @returns {object} An immutable NpmPackageInfoProjection@1.
 */
export function projectNpmPackageInfo(request) {
  const exactKeys = "keys,manifest,type,version";
  if (
    !isJsonRecord(request)
    || Object.keys(request).sort().join(",") !== exactKeys
    || request.type !== "NpmPackageInfoProjectionRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmPackageInfoProjectionRequest@1");
  }
  if (
    !isJsonRecord(request.manifest)
    || Object.keys(request.manifest).sort().join(",") !== "manifest,type,version"
    || request.manifest.type !== "NpmPackageManifest"
    || request.manifest.version !== 1
    || !isJsonRecord(request.manifest.manifest)
  ) {
    throw new TypeError("request.manifest must be an exact NpmPackageManifest@1");
  }
  if (
    !Array.isArray(request.keys)
    || request.keys.length === 0
    || request.keys.some((key) => typeof key !== "string" || key.length === 0)
    || new Set(request.keys).size !== request.keys.length
  ) {
    throw new TypeError("request.keys must be a nonempty list of distinct nonempty strings");
  }

  return freezeJson({
    type: "NpmPackageInfoProjection",
    version: 1,
    manifest: request.manifest,
    keys: request.keys,
    info: projectJsonRecordKeys({ record: request.manifest.manifest, keys: request.keys }),
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "project-npm-package-info", description: "Projects explicitly selected keys from an admitted npm package manifest.", operation: projectNpmPackageInfo, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
