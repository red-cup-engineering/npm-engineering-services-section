/**
 * Restored 2026-09-21 as this service's own module (recovered from the
 * pnpm-engine-declaration-normalization-service package deleted 2026-08-14,
 * commit ef78d5c41): drops a manifest's `engines.pnpm` declaration (and the
 * whole `engines` field when pnpm was its only entry), without touching any
 * other engine constraint.
 *
 * Its own stdin/stdout CLI entry point moved to
 * scripts/normalize-pnpm-engine-declaration.mjs -- see
 * normalize-npm-package-lifecycle-scripts.mjs's header comment for why.
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

export function normalizePnpmEngineDeclaration(manifest) {
  const admittedManifest = admittedManifestOf(manifest);
  if (!admittedManifest.engines?.pnpm) return admittedManifest;
  const { pnpm: _removedPnpmEngine, ...engines } = admittedManifest.engines;
  const { engines: _previousEngines, ...manifestWithoutEngines } = admittedManifest;
  return deepFreezeJson(Object.keys(engines).length === 0
    ? manifestWithoutEngines
    : { ...manifestWithoutEngines, engines });
}
