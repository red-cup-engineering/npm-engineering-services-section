import assert from "node:assert/strict";
import test from "node:test";

import { releasedManifest } from "../scripts/released-manifest.mjs";

test("projects local dependency protocols only through exact coordinated-release bindings", () => {
  const source = {
    name: "@customer/consumer",
    version: "1.0.0",
    dependencies: { "@customer/provider": "workspace:*", outside: "^4.0.0" },
    optionalDependencies: { "@customer/optional": "file:../optional" },
    peerDependencies: { "@customer/peer": "link:../peer" },
    devDependencies: { "@customer/development": "workspace:^" },
    releasePlan: {
      kind: "coordinated",
      id: "customer-release-2026-08-10",
      packages: ["@customer/consumer", "@customer/provider", "@customer/optional", "@customer/peer", "@customer/development"],
      dependencyBindings: {
        "@customer/provider": "2.3.4",
        "@customer/optional": "3.4.5",
        "@customer/peer": "4.5.6",
        "@customer/development": "5.6.7"
      }
    },
    "x-semiotic-voxel": { package: "@customer/consumer" },
    "x-agentic-metro-enterprise": { "node-id": "consumer" }
  };
  const projection = releasedManifest(source);
  assert.equal(projection.rewrite, true);
  assert.deepEqual(projection.manifest.dependencies, { "@customer/provider": "2.3.4", outside: "^4.0.0" });
  assert.equal(projection.manifest.optionalDependencies["@customer/optional"], "3.4.5");
  assert.equal(projection.manifest.peerDependencies["@customer/peer"], "4.5.6");
  assert.equal(projection.manifest.devDependencies["@customer/development"], "5.6.7");
  assert.equal("x-semiotic-voxel" in projection.manifest, false);
  assert.equal("x-agentic-metro-enterprise" in projection.manifest, false);
  assert.equal(source.dependencies["@customer/provider"], "workspace:*");
});

test("never falls back to a registry or local version for a local dependency", () => {
  assert.throws(
    () => releasedManifest({ name: "@customer/consumer", version: "1.0.0", dependencies: { "@customer/provider": "workspace:*" } }),
    /releasePlan is required/u,
  );
});

test("rejects incomplete or ambiguous coordinated-release bindings", () => {
  const base = {
    name: "@customer/consumer",
    dependencies: { "@customer/provider": "workspace:*" },
    releasePlan: {
      kind: "coordinated",
      id: "release",
      packages: ["@customer/consumer", "@customer/provider"],
      dependencyBindings: { "@customer/provider": "2.3.4" }
    }
  };
  assert.throws(() => releasedManifest({ ...base, releasePlan: { ...base.releasePlan, packages: ["@customer/consumer"] } }), /packages must name/u);
  assert.throws(() => releasedManifest({ ...base, releasePlan: { ...base.releasePlan, dependencyBindings: {} } }), /exactly the local dependency names/u);
  assert.throws(() => releasedManifest({ ...base, releasePlan: { ...base.releasePlan, dependencyBindings: { "@customer/provider": "^2.3.4" } } }), /exact version/u);
  assert.throws(() => releasedManifest({ ...base, releasePlan: { ...base.releasePlan, dependencyBindings: { "@customer/provider": "2.3.4", "@customer/extra": "1.0.0" } } }), /exactly the local dependency names/u);
});

test("keeps ordinary dependencies unchanged without requiring a release plan", () => {
  const manifest = { name: "@customer/ordinary", version: "1.0.0", dependencies: { outside: "^1.2.3", exact: "4.5.6" } };
  assert.deepEqual(releasedManifest(manifest), { manifest, rewrite: false });
});

test("preserves ordinary package interfaces while removing house metadata", () => {
  const source = {
    name: "@customer/tool",
    version: "1.0.0",
    exports: { ".": { import: "./src/index.mjs", types: "./src/index.d.mts" } },
    imports: { "#support": "./src/support.mjs" },
    bin: { tool: "./scripts/tool.mjs" },
    scripts: { check: "node --test" },
    engines: { node: ">=24" },
    os: ["linux", "darwin"],
    cpu: ["x64", "arm64"],
    "x-semiotic-voxel": { package: "@customer/tool" },
  };

  const projection = releasedManifest(source);

  assert.equal(projection.rewrite, true);
  assert.deepEqual(projection.manifest.exports, source.exports);
  assert.deepEqual(projection.manifest.imports, source.imports);
  assert.deepEqual(projection.manifest.bin, source.bin);
  assert.deepEqual(projection.manifest.scripts, source.scripts);
  assert.deepEqual(projection.manifest.engines, source.engines);
  assert.deepEqual(projection.manifest.os, source.os);
  assert.deepEqual(projection.manifest.cpu, source.cpu);
  assert.equal("x-semiotic-voxel" in projection.manifest, false);
});
