import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJsnodePackageManifest } from "../src/normalize-jsnode-package-manifest.mjs";

test("normalizes one manifest lifecycle without changing dependencies or the input", () => {
  const manifest = { name: "@emsenn/x", packageManager: "pnpm@11", engines: { node: ">=22", pnpm: ">=11" }, scripts: { verify: "pnpm run check && pnpm test" }, dependencies: { a: "workspace:*" } };
  const output = normalizeJsnodePackageManifest({ manifest, identity: { name: "@red-cup-engineering/x" } });
  assert.deepEqual(output.dependencies, manifest.dependencies);
  assert.equal(output.name, "@red-cup-engineering/x");
  assert.equal(output.version, "0.1.0");
  assert.equal(output.packageManager, undefined);
  assert.deepEqual(output.engines, { node: ">=22" });
  assert.equal(output.scripts.verify, "npm run check && npm test");
  assert.equal(manifest.packageManager, "pnpm@11");
});
