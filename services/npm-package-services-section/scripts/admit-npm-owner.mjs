#!/usr/bin/env node

import operationInputSchema from "../data/records/admit-npm-owner.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/admit-npm-owner.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Admits one already-canonical lowercase npm scope owner.
 * @param {string} candidate - The owner without an at-sign.
 * @returns {string} The unchanged owner.
 * @throws {TypeError} When the candidate is not canonical.
 */
export function admitNpmOwner(candidate) {
  if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(candidate)) {
    throw new TypeError("candidate must be a canonical lowercase npm owner without an at-sign");
  }
  return candidate;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-owner", description: "Admits one already-canonical lowercase npm scope owner.", operation: admitNpmOwner, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
