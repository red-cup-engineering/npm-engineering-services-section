#!/usr/bin/env node
import { admitNpmOwner } from "@red-cup-engineering/npm-owner-admission-service";
import operationInputSchema from "../data/records/admit-npm-owner.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/admit-npm-owner.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-owner", description: "Admits one already-canonical lowercase npm scope owner.", operation: admitNpmOwner, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
