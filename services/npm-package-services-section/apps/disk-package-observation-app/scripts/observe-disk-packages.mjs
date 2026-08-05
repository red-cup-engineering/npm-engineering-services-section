#!/usr/bin/env node
import { observeDiskPackages } from "../src/observe-disk-packages.mjs";

const DEFAULT_EXCLUDES = ["node_modules", ".git"];

function usage() {
  console.error(
    "usage: observe-disk-packages --root <path> [--exclude <segment>]... [--no-default-excludes] [--format ndjson|json|packages] [--strict]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let root = null;
let format = "ndjson";
let useDefaultExcludes = true;
let strict = false;
const excludes = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--root") root = args[++i];
  else if (arg === "--exclude") excludes.push(args[++i]);
  else if (arg === "--no-default-excludes") useDefaultExcludes = false;
  else if (arg === "--format") format = args[++i];
  else if (arg === "--strict") strict = true;
  else usage();
}
if (!root || !["ndjson", "json", "packages"].includes(format)) usage();
if (useDefaultExcludes) excludes.push(...DEFAULT_EXCLUDES);

const observation = await observeDiskPackages({ root, excludes });

if (format === "json") {
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
} else if (format === "packages") {
  for (const entry of observation.packages) {
    process.stdout.write(`${entry.name}@${entry.version}\n`);
  }
} else {
  for (const entry of observation.packages) {
    process.stdout.write(`${JSON.stringify({ kind: "package", ...entry })}\n`);
  }
  for (const defect of observation.defects) {
    process.stdout.write(`${JSON.stringify({ kind: "defect", ...defect })}\n`);
  }
  const { type, root: observedRoot, files, directories, excluded } = observation;
  process.stdout.write(
    `${JSON.stringify({ kind: "summary", type, root: observedRoot, packages: observation.packages.length, defects: observation.defects.length, files, directories, excluded })}\n`,
  );
}

process.exit(strict && observation.defects.length > 0 ? 1 : 0);
