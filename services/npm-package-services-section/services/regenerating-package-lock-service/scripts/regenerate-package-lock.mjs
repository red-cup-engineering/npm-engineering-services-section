#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function regeneratePackageLock({ directory = process.cwd(), apply = false, offline = false, npmBin = "npm" } = {}) {
  const cwd = resolve(directory);
  const args = ["install", "--package-lock-only", "--ignore-scripts"];
  if (offline) args.push("--offline");
  const plan = { directory: cwd, command: npmBin, arguments: args, apply };
  if (!apply) return Object.freeze(plan);
  const result = spawnSync(npmBin, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  return Object.freeze({ ...plan, completed: true });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--directory") options.directory = argv[++index];
    else if (argument === "--npm-bin") options.npmBin = argv[++index];
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--help") options.help = true;
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("usage: regenerate-package-lock [--directory <path>] [--offline] [--npm-bin <path>] [--apply]\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(regeneratePackageLock(options))}\n`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
