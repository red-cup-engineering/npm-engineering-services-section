import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJsnodePackageDependencies } from "../src/normalize-jsnode-package-dependencies.mjs";

test("normalizes one manifest's admitted provider dependencies", () => {
  const provider = { name: "@red-cup-engineering/provider", version: "3.0.0" };
  const output = normalizeJsnodePackageDependencies({
    manifest: { dependencies: { "@emsenn/provider": "workspace:*", external: "^1" } },
    manifestPath: "packages/consumer/package.json",
    root: "/repo",
    providersByName: new Map([["@emsenn/provider", provider]]),
  });
  assert.deepEqual(output.dependencies, { "@red-cup-engineering/provider": "3.0.0", external: "^1" });
});
