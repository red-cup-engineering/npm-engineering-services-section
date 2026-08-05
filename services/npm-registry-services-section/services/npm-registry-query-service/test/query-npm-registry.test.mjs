import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dependenciesOf, dependentsOf, packageExists, searchPackages } from "../src/query-npm-registry.mjs";

async function fixtureRegistry() {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-query-fixture-"));
  await mkdir(join(root, "metadata"), { recursive: true });
  const packages = [
    { name: "@customer/alpha", version: "1.0.0", dependencies: { "@customer/beta": "1.0.0" } },
    { name: "@customer/beta", version: "1.0.0", dependencies: {} },
    { name: "@customer/gamma-alpha-thing", version: "1.0.0", dependencies: { "@customer/beta": "1.0.0" } },
  ];
  for (const pkg of packages) {
    await writeFile(join(root, "metadata", `${encodeURIComponent(pkg.name)}.json`), JSON.stringify({
      _id: pkg.name,
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: { [pkg.version]: { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies } },
    }));
  }
  await writeFile(join(root, "registry-receipt.json"), JSON.stringify({
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: "http://registry.invalid/",
    packages: packages.map(({ name, version }) => ({ name, version })),
    scopes: ["customer"],
  }));
  return root;
}

test("packageExists answers a clean true and a clean false, never throws for absence", async () => {
  const root = await fixtureRegistry();
  try {
    const present = await packageExists({ registryRoot: root, name: "@customer/alpha" });
    assert.equal(present.exists, true);
    const absent = await packageExists({ registryRoot: root, name: "@customer/does-not-exist" });
    assert.equal(absent.exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchPackages matches by substring and by explicit RegExp, empty result is not an error", async () => {
  const root = await fixtureRegistry();
  try {
    const bySubstring = await searchPackages({ registryRoot: root, pattern: "alpha" });
    assert.deepEqual(bySubstring.matches, ["@customer/alpha", "@customer/gamma-alpha-thing"]);
    const byRegex = await searchPackages({ registryRoot: root, pattern: /^@customer\/alpha$/u });
    assert.deepEqual(byRegex.matches, ["@customer/alpha"]);
    const none = await searchPackages({ registryRoot: root, pattern: "nothing-like-this" });
    assert.deepEqual(none.matches, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependenciesOf resolves dist-tags.latest by default and reports found:false for an absent package", async () => {
  const root = await fixtureRegistry();
  try {
    const found = await dependenciesOf({ registryRoot: root, name: "@customer/alpha" });
    assert.equal(found.found, true);
    assert.deepEqual(found.dependencies, [{ name: "@customer/beta", constraint: "1.0.0" }]);
    const absent = await dependenciesOf({ registryRoot: root, name: "@customer/nope" });
    assert.equal(absent.found, false);
    assert.deepEqual(absent.dependencies, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependentsOf finds every receipt package that directly depends on the named package", async () => {
  const root = await fixtureRegistry();
  try {
    const answer = await dependentsOf({ registryRoot: root, name: "@customer/beta" });
    assert.deepEqual(answer.dependents.map((row) => row.name), ["@customer/alpha", "@customer/gamma-alpha-thing"]);
    const none = await dependentsOf({ registryRoot: root, name: "@customer/alpha" });
    assert.deepEqual(none.dependents, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses supplying both registryRoot and registryUrl, and neither", async () => {
  await assert.rejects(() => packageExists({ registryRoot: "/tmp/a", registryUrl: "http://x/", name: "@customer/alpha" }), TypeError);
  await assert.rejects(() => packageExists({ name: "@customer/alpha" }), TypeError);
});
