import { freezeJson } from "@red-cup-engineering/json-services-section/freeze-json";
/**
 * Restored 2026-09-21 as this service's own module (recovered from the
 * pnpm-package-manager-declaration-normalization-service package deleted
 * 2026-08-14, commit ef78d5c41): drops a manifest's `packageManager` field
 * when it names pnpm, without touching any other declaration.
 *
 * Its own stdin/stdout CLI entry point moved to
 * scripts/normalize-pnpm-package-manager-declaration.mjs -- see
 * normalize-npm-package-lifecycle-scripts.mjs's header comment for why.
 */
import { admitNpmPackageManifest } from "@red-cup-engineering/npm-package-manifest-admission-service";


function admittedManifestOf(manifest) {
  return admitNpmPackageManifest({ type: "NpmPackageManifestCandidate", version: 1, manifest }).manifest;
}

export function normalizePnpmPackageManagerDeclaration(manifest) {
  const admittedManifest = admittedManifestOf(manifest);
  if (!admittedManifest.packageManager?.startsWith("pnpm@")) return admittedManifest;
  const { packageManager: _removedPackageManager, ...normalizedManifest } = admittedManifest;
  return freezeJson(normalizedManifest);
}
