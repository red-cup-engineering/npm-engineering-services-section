#!/usr/bin/env node
import { formNpmScopedPackageName } from "@red-cup-engineering/npm-scoped-package-name-formation-service";
import operationInputSchema from "../data/records/form-npm-scoped-package-name.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/form-npm-scoped-package-name.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "form-npm-scoped-package-name", description: "Forms one scoped npm package name from separately admitted owner and leaf inputs.", operation: formNpmScopedPackageName, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
