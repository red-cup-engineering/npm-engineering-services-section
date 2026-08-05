import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJsnodePackageIdentity } from "../src/normalize-jsnode-package-identity.mjs";

test("normalizes one scoped package identity under an explicit owner", () => {
  assert.deepEqual(normalizeJsnodePackageIdentity({
    packageName: "@emsenn/example-service",
    owner: "red-cup-engineering",
  }), {
    type: "JsnodePackageIdentityNormalization",
    priorName: "@emsenn/example-service",
    owner: "red-cup-engineering",
    leaf: "example-service",
    name: "@red-cup-engineering/example-service",
  });
});

test("preserves the existing eo-prefix normalization without accepting a path as ownership evidence", () => {
  assert.equal(normalizeJsnodePackageIdentity({ packageName: "eo-widget", owner: "@561-group" }).name, "@561-group/widget");
});

test("normalizes only the supplied value and does not mutate it", () => {
  const input = { packageName: "Legacy Package", owner: "red-cup-engineering" };
  const before = structuredClone(input);
  assert.equal(normalizeJsnodePackageIdentity(input).name, "@red-cup-engineering/legacy-package");
  assert.deepEqual(input, before);
});

test("refuses absent or invalid identity material", () => {
  assert.throws(() => normalizeJsnodePackageIdentity(), /packageName/u);
  assert.throws(() => normalizeJsnodePackageIdentity({ packageName: "@scope/name", owner: "Owner With Spaces" }), /owner/u);
  assert.throws(() => normalizeJsnodePackageIdentity({ packageName: "---", owner: "red-cup-engineering" }), /package leaf/u);
});
