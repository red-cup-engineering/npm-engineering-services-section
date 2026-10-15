#!/usr/bin/env node
import { admitNpmPackageNameLeaf } from "@red-cup-engineering/npm-package-name-leaf-admission-service";
import operationInputSchema from "../data/records/admit-npm-package-name-leaf.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/admit-npm-package-name-leaf.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-name-leaf", description: "Admits one already-canonical lowercase npm package-name leaf.", operation: admitNpmPackageNameLeaf, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
