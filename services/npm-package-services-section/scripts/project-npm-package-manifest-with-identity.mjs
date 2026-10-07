#!/usr/bin/env node

import { admitNpmPackageManifest } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-manifest";
import { admitNpmPackageVersion } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-version";

import operationInputSchema from "../data/records/project-npm-package-manifest-with-identity.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/project-npm-package-manifest-with-identity.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Projects a supplied npm manifest body with an explicit admitted identity.
 * @param {object} request - An NpmPackageManifestIdentityProjectionRequest@1.
 * @returns {object} An immutable NpmPackageManifest@1.
 */
export function projectNpmPackageManifestWithIdentity(request) {
  if (
    request === null
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "manifest,name,packageVersion,type,version"
    || request.type !== "NpmPackageManifestIdentityProjectionRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmPackageManifestIdentityProjectionRequest@1");
  }
  const body = admitNpmPackageManifest({ type: "NpmPackageManifestCandidate", version: 1, manifest: request.manifest }).manifest;
  const projected = { ...body, name: request.name, version: admitNpmPackageVersion(request.packageVersion) };
  return admitNpmPackageManifest({ type: "NpmPackageManifestCandidate", version: 1, manifest: projected });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "project-npm-package-manifest-with-identity", description: "Projects a supplied npm manifest body with an explicit admitted identity.", operation: projectNpmPackageManifestWithIdentity, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
