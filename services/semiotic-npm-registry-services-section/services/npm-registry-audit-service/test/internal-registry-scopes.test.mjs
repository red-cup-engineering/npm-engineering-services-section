import assert from "node:assert/strict";
import test from "node:test";

import { deriveInternalRegistryScopes } from "../src/internal-registry-scopes.mjs";

// Mirrors the real verdaccio-services-section config.yaml shape: an anchor on
// the first scope, aliased on the rest, two bare (non-scope) package names,
// and the `**` catch-all — every shape the extractor must handle.
const CONFIG_YAML = `storage: ../../data/storage

auth:
  htpasswd:
    file: ../../data/htpasswd
    max_users: 1

packages:
  '@561-group/*': &private_packages
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '@causeway-services/*': *private_packages
  '@coesite-operations/*': *private_packages
  '@emsenn/*': *private_packages
  '@lenticule-science/*': *private_packages
  '@red-cup-engineering/*': *private_packages
  '561-group-ephemeral-computer-machine-services-section': *private_packages
  '561-group-persistent-computer-machine-services-section': *private_packages
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs

web:
  enable: true
`;

test("reads every scope declared in the packages: block", () => {
  assert.deepEqual(
    deriveInternalRegistryScopes(CONFIG_YAML),
    ["561-group", "causeway-services", "coesite-operations", "emsenn", "lenticule-science", "red-cup-engineering"],
  );
});

test("excludes the ** catch-all and bare (non-scope) package names", () => {
  const scopes = deriveInternalRegistryScopes(CONFIG_YAML);
  assert.equal(scopes.includes("*"), false);
  assert.equal(scopes.includes("561-group-ephemeral-computer-machine-services-section"), false);
});

test("a scope missing from config.yaml is not returned", () => {
  const withoutCoesiteOperations = CONFIG_YAML.replace("  '@coesite-operations/*': *private_packages\n", "");
  const scopes = deriveInternalRegistryScopes(withoutCoesiteOperations);
  assert.equal(scopes.includes("coesite-operations"), false);
});

test("dedupes a scope declared twice and sorts the result", () => {
  const doubled = CONFIG_YAML.replace(
    "  '@causeway-services/*': *private_packages\n",
    "  '@causeway-services/*': *private_packages\n  '@causeway-services/*': *private_packages\n",
  );
  assert.deepEqual(
    deriveInternalRegistryScopes(doubled),
    ["561-group", "causeway-services", "coesite-operations", "emsenn", "lenticule-science", "red-cup-engineering"],
  );
});

test("stops at the end of the packages: block and ignores later top-level sections", () => {
  const scopes = deriveInternalRegistryScopes(CONFIG_YAML);
  assert.equal(scopes.includes("enable"), false);
});

test("returns an empty array when there is no packages: block", () => {
  assert.deepEqual(deriveInternalRegistryScopes("storage: ../../data/storage\n"), []);
});

test("rejects a non-string input", () => {
  assert.throws(() => deriveInternalRegistryScopes(undefined), TypeError);
});
