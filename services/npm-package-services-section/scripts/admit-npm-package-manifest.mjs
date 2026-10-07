#!/usr/bin/env node
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { isJsonRecord } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { admitNpmPackageNameLeaf } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-name-leaf";
import { admitNpmPackageVersion } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-version";
import { formNpmScopedPackageName } from "@red-cup-engineering/npm-package-services-section/form-npm-scoped-package-name";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

function admitName(name) {
  if (name.startsWith("@")) {
    const match = /^@([^/]+)\/([^/]+)$/u.exec(name);
    if (!match || formNpmScopedPackageName({ type: "NpmScopedPackageNameFormationRequest", version: 1, owner: match[1], leaf: match[2] }) !== name) throw new TypeError("manifest.name must be a canonical npm package name");
  } else admitNpmPackageNameLeaf(name);
}
function stringRecord(value, field) {
  if (!isJsonRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new TypeError(`manifest.${field} must be a string record`);
  }
}

/**
 * Admits one npm package manifest candidate without changing its fields.
 *
 * @param {object} candidate - An NpmPackageManifestCandidate@1.
 * @returns {object} An immutable NpmPackageManifest@1.
 */
export function admitNpmPackageManifest(candidate) {
  if (
    candidate === null
    || typeof candidate !== "object"
    || Array.isArray(candidate)
    || Object.keys(candidate).sort().join(",") !== "manifest,type,version"
    || candidate.type !== "NpmPackageManifestCandidate"
    || candidate.version !== 1
  ) {
    throw new TypeError("candidate must be an exact NpmPackageManifestCandidate@1");
  }
  if (!isJsonRecord(candidate.manifest)) throw new TypeError("candidate.manifest must be a JSON record");
  const manifest = candidate.manifest;
  if (manifest.name !== undefined) {
    if (typeof manifest.name !== "string") throw new TypeError("manifest.name must be a string");
    admitName(manifest.name);
  }
  if (manifest.version !== undefined) admitNpmPackageVersion(manifest.version);
  if (manifest.private !== undefined && typeof manifest.private !== "boolean") throw new TypeError("manifest.private must be a boolean");
  for (const field of ["scripts", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field] !== undefined) stringRecord(manifest[field], field);
  }
  return freezeJson({ type: "NpmPackageManifest", version: 1, manifest });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-manifest", description: "Admits one npm package manifest candidate without changing its fields.", operation: admitNpmPackageManifest }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
