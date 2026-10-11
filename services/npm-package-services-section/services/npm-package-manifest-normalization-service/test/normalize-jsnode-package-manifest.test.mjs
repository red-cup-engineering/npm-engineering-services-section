import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJsnodePackageManifest } from "../src/normalize-jsnode-package-manifest.mjs";

const manifest = {
  name: "@red-cup-engineering/example-service",
  version: "0.5.0-dev.0",
  type: "module",
  scripts: { test: "pnpm exec node --test" },
  packageManager: "pnpm@9.0.0",
  engines: { node: ">=24", pnpm: ">=9" },
};

test("preserves an exact valid prerelease version while normalizing declarations", () => {
  const normalized = normalizeJsnodePackageManifest({
    manifest,
    identity: { name: manifest.name },
  });
  assert.equal(normalized.version, "0.5.0-dev.0");
  assert.equal(normalized.packageManager, undefined);
  assert.deepEqual(normalized.engines, { node: ">=24" });
});

test("refuses invalid or missing versions instead of inventing a fallback", () => {
  assert.throws(
    () => normalizeJsnodePackageManifest({ manifest: { ...manifest, version: undefined }, identity: { name: manifest.name } }),
    TypeError,
  );
  for (const version of ["next", "1.2", "01.2.3"]) {
    assert.throws(
      () => normalizeJsnodePackageManifest({ manifest: { ...manifest, version }, identity: { name: manifest.name } }),
      /exact SemVer/u,
    );
  }
});
