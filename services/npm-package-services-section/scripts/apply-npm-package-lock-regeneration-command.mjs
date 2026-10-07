#!/usr/bin/env node
import path from "node:path";
import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";
import { freezeJson } from "@red-cup-engineering/json-services-section";

import operationInputSchema from "../data/records/apply-npm-package-lock-regeneration-command.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/apply-npm-package-lock-regeneration-command.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Applies one admitted npm package-lock regeneration command.
 * @param {object} command An exact NpmPackageLockRegenerationCommand@1.
 * @returns {object} An immutable NpmPackageLockRegenerationCommandApplicationReceipt@1.
 */
export function applyNpmPackageLockRegenerationCommand(command) {
  if (
    command === null
    || typeof command !== "object"
    || Array.isArray(command)
    || Object.keys(command).sort().join(",") !== "arguments,command,directory,type,version"
    || command.type !== "NpmPackageLockRegenerationCommand"
    || command.version !== 1
    || typeof command.command !== "string"
    || command.command.length === 0
    || typeof command.directory !== "string"
    || !path.isAbsolute(command.directory)
    || path.resolve(command.directory) !== command.directory
    || !Array.isArray(command.arguments)
    || !(
      command.arguments.length === 3
      || (command.arguments.length === 4 && command.arguments[3] === "--offline")
    )
    || command.arguments[0] !== "install"
    || command.arguments[1] !== "--package-lock-only"
    || command.arguments[2] !== "--ignore-scripts"
  ) throw new TypeError("command must be an exact NpmPackageLockRegenerationCommand@1");
  const executionReceipt = executeJavascriptNodeCommand({
    type: "JavascriptNodeCommandExecutionRequest",
    version: 1,
    command: command.command,
    arguments: command.arguments,
    directory: command.directory,
    environment: null,
    input: null,
  });
  const execution = executionReceipt.result;
  if (execution.status !== 0) throw new Error(`npm package-lock regeneration failed: ${execution.error || execution.stderr || execution.stdout}`);
  return freezeJson({
    type: "NpmPackageLockRegenerationCommandApplicationReceipt",
    version: 1,
    command,
    execution,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "apply-npm-package-lock-regeneration-command", description: "Applies one admitted npm package-lock regeneration command.", operation: applyNpmPackageLockRegenerationCommand, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
