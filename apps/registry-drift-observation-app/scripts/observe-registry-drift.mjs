#!/usr/bin/env node
import { observeRegistryDrift } from "../src/observe-registry-drift.mjs";

// "dist" joins node_modules/.git as a default exclude on evidence, not
// caution: at least one service section (web-services-section/relating)
// carries a build-output dist/ tree that mirrors its own services/
// directory file-for-file, including package.json — the walker sees both
// as distinct packages with the same name@version, and the registry
// builder correctly refuses that as a duplicate-package-version collision.
// pnpm-workspace.yaml already excludes dist/ from workspace linking for
// the same reason.
const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist"];

function usage() {
  console.error(
    "usage: observe-registry-drift --root <path> --registry-url <url> [--exclude <segment>]... [--no-default-excludes] [--format ndjson|json|summary] [--strict]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let root = null;
let registryUrl = null;
let format = "ndjson";
let useDefaultExcludes = true;
let strict = false;
const excludes = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--root") root = args[++i];
  else if (arg === "--registry-url") registryUrl = args[++i];
  else if (arg === "--exclude") excludes.push(args[++i]);
  else if (arg === "--no-default-excludes") useDefaultExcludes = false;
  else if (arg === "--format") format = args[++i];
  else if (arg === "--strict") strict = true;
  else usage();
}
if (!root || !registryUrl || !["ndjson", "json", "summary"].includes(format)) usage();
if (useDefaultExcludes) excludes.push(...DEFAULT_EXCLUDES);

const observation = await observeRegistryDrift({ root, excludes, registryUrl });

if (format === "json") {
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
} else if (format === "summary") {
  process.stdout.write(`${JSON.stringify({
    type: observation.type,
    root: observation.root,
    registry: observation.registry,
    packages: observation.findings.length,
    counts: observation.counts,
    diskDefects: observation.diskDefects.length,
    receiptFound: observation.receiptFound,
    receiptScopeNote: observation.receiptScopeNote,
  }, null, 2)}\n`);
} else {
  for (const finding of observation.findings) {
    process.stdout.write(`${JSON.stringify({ kind: "finding", ...finding })}\n`);
  }
  for (const defect of observation.diskDefects) {
    process.stdout.write(`${JSON.stringify({ kind: "disk-defect", ...defect })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    kind: "summary",
    type: observation.type,
    root: observation.root,
    registry: observation.registry,
    packages: observation.findings.length,
    counts: observation.counts,
    diskDefects: observation.diskDefects.length,
    receiptFound: observation.receiptFound,
    receiptScopeNote: observation.receiptScopeNote,
  })}\n`);
}

const clean = observation.counts["stale-manifest"] === 0 && observation.counts.unpublished === 0 && observation.counts["source-missing"] === 0;
process.exit(strict && !clean ? 1 : 0);
