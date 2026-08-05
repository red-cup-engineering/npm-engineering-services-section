import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJsnodePackageIdentityReferences } from "../src/normalize-jsnode-package-identity-references.mjs";

test("applies one ordered admitted identity-replacement set to supplied source", () => {
  assert.equal(normalizeJsnodePackageIdentityReferences({ source: 'import "@emsenn/a";', replacements: [["@emsenn/a", "@owner/a"]] }), 'import "@owner/a";');
});
