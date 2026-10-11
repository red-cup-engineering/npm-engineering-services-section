/**
 * Restored 2026-09-21 as this service's own module (recovered from the
 * npm-package-manifest-identity-application-service package deleted
 * 2026-08-14, commit ef78d5c41): applies one admitted identity's name onto
 * an admitted manifest, without inventing or guessing an identity.
 *
 * Its own stdin/stdout CLI entry point moved to
 * scripts/apply-npm-package-manifest-identity.mjs -- see
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

export function applyNpmPackageManifestIdentity({ manifest, identity } = {}) {
  const admittedManifest = admittedManifestOf(manifest);
  if (!identity || typeof identity.name !== "string" || identity.name.length === 0) throw new TypeError("identity.name must be a nonempty string");
  return deepFreezeJson({ ...admittedManifest, name: identity.name });
}
