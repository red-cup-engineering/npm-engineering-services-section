#!/usr/bin/env node
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const NON_NUMERIC_IDENTIFIER = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const VERSION_PATTERN = new RegExp(
  `^${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}`
    + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
    + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  "u",
);

/**
 * Admits one explicit exact SemVer npm package version.
 *
 * @param {string} candidate - The candidate version.
 * @returns {string} The unchanged admitted version.
 * @throws {TypeError} When the candidate is not exact.
 */
export function admitNpmPackageVersion(candidate) {
  if (typeof candidate !== "string" || !VERSION_PATTERN.test(candidate)) {
    throw new TypeError("candidate must be an explicit exact SemVer npm package version");
  }
  return candidate;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-version", description: "Admits one explicit exact SemVer npm package version.", operation: admitNpmPackageVersion }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
