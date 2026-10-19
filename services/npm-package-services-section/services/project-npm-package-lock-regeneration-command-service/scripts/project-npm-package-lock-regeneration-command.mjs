#!/usr/bin/env node
import path from "node:path";
import { freezeJson } from "@red-cup-engineering/json-services-section";

import operationInputSchema from "../data/records/schema/project-npm-package-lock-regeneration-command.input.schema.json" with { type: "json" };
import operationOutputSchema from "../data/records/schema/project-npm-package-lock-regeneration-command.output.schema.json" with { type: "json" };
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

/**
 * Projects one explicit request to the shell-free command which regenerates its package lock.
 * @param {object} request An exact NpmPackageLockRegenerationCommandProjectionRequest@1.
 * @returns {object} An immutable NpmPackageLockRegenerationCommand@1.
 */
export function projectNpmPackageLockRegenerationCommand(request) {
  if (
    request === null
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "directory,npmExecutable,offline,type,version"
    || request.type !== "NpmPackageLockRegenerationCommandProjectionRequest"
    || request.version !== 1
  ) throw new TypeError("request must be an exact NpmPackageLockRegenerationCommandProjectionRequest@1");
  const { directory, npmExecutable, offline } = request;
  if (
    directory === null
    || typeof directory !== "object"
    || Array.isArray(directory)
    || Object.keys(directory).sort().join(",") !== "path,type,version"
    || directory.type !== "NpmPackageDirectory"
    || directory.version !== 1
    || typeof directory.path !== "string"
    || !path.isAbsolute(directory.path)
    || path.resolve(directory.path) !== directory.path
  ) throw new TypeError("request.directory must be an exact NpmPackageDirectory@1 with an absolute normalized path");
  if (typeof npmExecutable !== "string" || npmExecutable.length === 0) throw new TypeError("request.npmExecutable must be a nonempty string");
  if (typeof offline !== "boolean") throw new TypeError("request.offline must be a boolean");
  const commandArguments = ["install", "--package-lock-only", "--ignore-scripts"];
  if (offline) commandArguments.push("--offline");
  return freezeJson({
    type: "NpmPackageLockRegenerationCommand",
    version: 1,
    command: npmExecutable,
    arguments: commandArguments,
    directory: directory.path,
  });
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "project-npm-package-lock-regeneration-command", description: "Projects one explicit request to the shell-free command which regenerates its package lock.", operation: projectNpmPackageLockRegenerationCommand, inputSchema: operationInputSchema, outputSchema: operationOutputSchema }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
