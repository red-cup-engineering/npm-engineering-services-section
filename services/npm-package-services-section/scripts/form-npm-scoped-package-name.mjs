#!/usr/bin/env node

import { admitNpmOwner } from "@red-cup-engineering/npm-package-services-section/admit-npm-owner";
import { admitNpmPackageNameLeaf } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-name-leaf";

import operationInputSchema from "../data/records/form-npm-scoped-package-name.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/form-npm-scoped-package-name.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Forms one scoped npm package name from separately admitted owner and leaf inputs.
 * @param {object} request - An NpmScopedPackageNameFormationRequest@1.
 * @returns {string} The scoped package name.
 */
export function formNpmScopedPackageName(request) {
  if (
    request === null
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "leaf,owner,type,version"
    || request.type !== "NpmScopedPackageNameFormationRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmScopedPackageNameFormationRequest@1");
  }
  return `@${admitNpmOwner(request.owner)}/${admitNpmPackageNameLeaf(request.leaf)}`;
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "form-npm-scoped-package-name", description: "Forms one scoped npm package name from separately admitted owner and leaf inputs.", operation: formNpmScopedPackageName, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
