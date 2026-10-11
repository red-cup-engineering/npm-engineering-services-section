import { normalizeNpmPackageLifecycleScripts } from "./normalize-npm-package-lifecycle-scripts.mjs";
import { applyNpmPackageManifestIdentity } from "./apply-npm-package-manifest-identity.mjs";
import { admitNpmPackageVersion } from "@red-cup-engineering/npm-package-services-section/admit-npm-package-version";
import { normalizePnpmEngineDeclaration } from "./normalize-pnpm-engine-declaration.mjs";
import { normalizePnpmPackageManagerDeclaration } from "./normalize-pnpm-package-manager-declaration.mjs";

/**
 * Normalizes one admitted npm package manifest while preserving its exact
 * declared version. Invalid or missing versions are refused rather than
 * replaced with an invented fallback.
 */
export function normalizeJsnodePackageManifest({ manifest, identity } = {}) {
  const identifiedManifest = applyNpmPackageManifestIdentity({ manifest, identity });
  const versionedManifest = {
    ...identifiedManifest,
    version: admitNpmPackageVersion(identifiedManifest.version),
  };
  const packageManagerNormalizedManifest = normalizePnpmPackageManagerDeclaration(versionedManifest);
  const engineNormalizedManifest = normalizePnpmEngineDeclaration(packageManagerNormalizedManifest);
  return normalizeNpmPackageLifecycleScripts(engineNormalizedManifest);
}
