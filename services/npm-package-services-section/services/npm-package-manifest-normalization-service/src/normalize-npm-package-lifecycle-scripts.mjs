/**
 * Restored 2026-09-21 as this service's own module (recovered from the
 * npm-package-lifecycle-scripts-normalization-service package deleted
 * 2026-08-14, commit ef78d5c41): rewrites every pnpm-specific lifecycle
 * script command to its npm equivalent, without changing any other field.
 *
 * Its own stdin/stdout CLI entry point (once `if (import.meta.main)` here) moved to
 * scripts/normalize-npm-package-lifecycle-scripts.mjs, run-stdin-json-cli.mjs's real stdin
 * read/stdout write: this file relative-importing it -- even guarded, even for code that only
 * runs when this file is executed directly -- was still a hull module reaching a kernel one
 * (data/records/house-architecture-norms.json, "hull-never-imports-kernel"). The export below
 * keeps its exact name and behavior.
 */
import { admitNpmPackageManifest } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-manifest";

function deepFreezeJson(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreezeJson(value[key]);
  return Object.freeze(value);
}

function admittedManifestOf(manifest) {
  return admitNpmPackageManifest({ type: "NpmPackageManifestCandidate", version: 1, manifest }).manifest;
}

/** Rewrites one pnpm-specific lifecycle command to its npm equivalent. */
function normalizePnpmLifecycleCommand(command) {
  if (typeof command !== "string") throw new TypeError("command must be a string");
  return command.replaceAll("pnpm run ", "npm run ").replaceAll("pnpm test", "npm test");
}

export function normalizeNpmPackageLifecycleScripts(manifest) {
  const admittedManifest = admittedManifestOf(manifest);
  if (!admittedManifest.scripts) return admittedManifest;
  const scripts = Object.fromEntries(Object.entries(admittedManifest.scripts).map(([name, command]) => [
    name,
    typeof command === "string" ? normalizePnpmLifecycleCommand(command) : command,
  ]));
  return deepFreezeJson({ ...admittedManifest, scripts });
}
