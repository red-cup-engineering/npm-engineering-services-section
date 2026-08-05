#!/usr/bin/env node
import { dependenciesOf, dependentsOf, packageExists, searchPackages } from "../src/query-npm-registry.mjs";

function option(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    if (!required) return undefined;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

const registry = option("--registry");
const target = /^https?:\/\//u.test(registry) ? { registryUrl: registry } : { registryRoot: registry };

const existsName = option("--exists", { required: false });
const searchPattern = option("--search", { required: false });
const dependsOnName = option("--depends-on", { required: false });
const dependedByName = option("--depended-by", { required: false });
const modes = [existsName, searchPattern, dependsOnName, dependedByName].filter((value) => value !== undefined);
if (modes.length !== 1) throw new Error("supply exactly one of --exists, --search, --depends-on, --depended-by");

if (existsName !== undefined) {
  const answer = await packageExists({ ...target, name: existsName });
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  process.exitCode = answer.exists ? 0 : 1;
} else if (searchPattern !== undefined) {
  const regex = option("--regex", { required: false });
  const answer = await searchPackages({ ...target, pattern: regex !== undefined ? new RegExp(regex, "iu") : searchPattern });
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
} else if (dependsOnName !== undefined) {
  const version = option("--version", { required: false });
  const answer = await dependenciesOf({ ...target, name: dependsOnName, version });
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  if (!answer.found) process.exitCode = 1;
} else {
  const answer = await dependentsOf({ ...target, name: dependedByName });
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
}
