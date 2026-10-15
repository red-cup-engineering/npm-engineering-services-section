#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord, parse } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { admitNpmPackageManifest } from "@red-cup-engineering/npm-package-manifest-admission-service";
import { projectNpmPackageManifestPath } from "@red-cup-engineering/computer-filepath-engineering-services-section/project-npm-package-manifest-path";

import operationInputSchema from "../data/records/read-npm-package-manifest.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/read-npm-package-manifest.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Reads and admits package.json from one explicit npm package directory.
 * @param {object} request An NpmPackageManifestReadRequest@1.
 * @returns {Promise<object>} An immutable NpmPackageManifestRead@1.
 */
export async function readNpmPackageManifest(request) {
  if (
    !isJsonRecord(request)
    || Object.keys(request).sort().join(",") !== "directory,type,version"
    || request.type !== "NpmPackageManifestReadRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmPackageManifestReadRequest@1");
  }
  const projection = projectNpmPackageManifestPath(request.directory);
  const text = await readFile(projection.path, "utf8");
  const manifest = admitNpmPackageManifest({
    type: "NpmPackageManifestCandidate",
    version: 1,
    manifest: parse(text),
  });
  return freezeJson({
    type: "NpmPackageManifestRead",
    version: 1,
    directory: request.directory,
    path: projection.path,
    text,
    manifest,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "read-npm-package-manifest", description: "Reads and admits package.json from one explicit npm package directory.", operation: readNpmPackageManifest, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
