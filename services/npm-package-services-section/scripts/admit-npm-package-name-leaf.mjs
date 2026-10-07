#!/usr/bin/env node

import operationInputSchema from "../data/records/admit-npm-package-name-leaf.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/admit-npm-package-name-leaf.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Admits one already-canonical lowercase npm package-name leaf.
 * @param {string} candidate - The candidate leaf.
 * @returns {string} The unchanged leaf.
 * @throws {TypeError} When the candidate is invalid.
 */
export function admitNpmPackageNameLeaf(candidate) {
  if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(candidate)) {
    throw new TypeError("candidate must be a canonical lowercase npm package-name leaf");
  }
  return candidate;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-name-leaf", description: "Admits one already-canonical lowercase npm package-name leaf.", operation: admitNpmPackageNameLeaf, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
