import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveRegistryGraph, groupRegistryGraphDefects, renderRegistryGraphDot } from "../src/registry-graph.mjs";

async function writeFixtureRegistry(root, { pin = "1.0.0", supersedes = { package: "@example/leaf", version: "1.0.0", reason: "fixture replacement" } } = {}) {
  await mkdir(join(root, "metadata"), { recursive: true });
  const manifests = {
    "@example/leaf": {
      name: "@example/leaf",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "0.9.0": {
          name: "@example/leaf",
          version: "0.9.0",
          dist: { shasum: "old-leaf-sha", integrity: "sha512-old-leaf" },
        },
        "1.0.0": {
          name: "@example/leaf",
          version: "1.0.0",
          dist: { shasum: "leaf-sha", integrity: "sha512-leaf" },
        },
      },
    },
    "@example/stem": {
      name: "@example/stem",
      versions: {
        "2.0.0": {
          name: "@example/stem",
          version: "2.0.0",
          dependencies: { "@example/leaf": pin },
          devDependencies: { typescript: "^5.8.0" },
          redCupEngineering: { supersedes },
          dist: { shasum: "stem-sha", integrity: "sha512-stem" },
        },
      },
    },
  };
  for (const [name, metadata] of Object.entries(manifests)) {
    await writeFile(join(root, "metadata", `${encodeURIComponent(name)}.json`), `${JSON.stringify(metadata)}\n`);
  }
  await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify({
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: "http://registry.example.test/",
    predecessor: null,
    reaction: null,
    scopes: ["example"],
    compute: { provider: "example-test", parallelism: 1 },
    packages: [
      { name: "@example/stem", version: "2.0.0", artifact: "tarballs/example/stem/-/stem-2.0.0.tgz", bytes: 2, shasum: "stem-sha", integrity: "sha512-stem" },
      { name: "@example/leaf", version: "1.0.0", artifact: "tarballs/example/leaf/-/leaf-1.0.0.tgz", bytes: 1, shasum: "leaf-sha", integrity: "sha512-leaf" },
    ],
  })}\n`);
}

test("derives deterministic dependency, history, and witness graph tiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.equal(graph.type, "NpmRegistryGraph");
    assert.deepEqual(graph.nodes.map((node) => node.address.packageSurface), ["@example/leaf@1.0.0", "@example/stem@2.0.0"]);
    assert.deepEqual(graph.tiers.history.edges, [{
      from: "@example/stem@2.0.0",
      to: "@example/leaf@1.0.0",
      relation: "supersedes",
      resolution: "registry",
      reason: "fixture replacement",
    }]);
    assert.match(renderRegistryGraphDot(graph, { tier: "dependency" }), /"@example\/stem@2\.0\.0" -> "@example\/leaf@1\.0\.0"/u);
    assert.equal(graph.defects.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observes an available nonlatest internal exact pin without calling it an installability defect", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { pin: "0.9.0" });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, []);
    assert.deepEqual(graph.observations, [{
      kind: "available-nonlatest-internal-dependency",
      from: "@example/stem@2.0.0",
      to: "@example/leaf@0.9.0",
      relation: "dependencies",
    }]);
    assert.deepEqual(graph.tiers.dependency.edges.find((edge) => edge.to === "@example/leaf@0.9.0"), {
      from: "@example/stem@2.0.0",
      to: "@example/leaf@0.9.0",
      constraint: "0.9.0",
      relation: "dependencies",
      resolution: "available-nonlatest-internal-dependency",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves a normal npm semver range to the latest matching internal release", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { pin: "^0.9.0" });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, []);
    assert.deepEqual(graph.tiers.dependency.edges.find((edge) => edge.from === "@example/stem@2.0.0" && edge.relation === "dependencies"), {
      from: "@example/stem@2.0.0",
      to: "@example/leaf@0.9.0",
      constraint: "^0.9.0",
      relation: "dependencies",
      resolution: "available-nonlatest-internal-dependency",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves an npm package alias to its actual internal release", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { pin: "npm:@example/leaf@^1.0.0" });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, []);
    assert.deepEqual(graph.tiers.dependency.edges.find((edge) => edge.from === "@example/stem@2.0.0" && edge.relation === "dependencies"), {
      from: "@example/stem@2.0.0",
      to: "@example/leaf@1.0.0",
      constraint: "npm:@example/leaf@^1.0.0",
      relation: "dependencies",
      resolution: "registry",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an absent internal exact version as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { pin: "9.9.9" });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, [{
      kind: "unavailable-internal-dependency",
      from: "@example/stem@2.0.0",
      to: "@example/leaf@9.9.9",
      relation: "dependencies",
    }]);
    assert.deepEqual(groupRegistryGraphDefects(graph.defects), [{
      kind: "unavailable-internal-dependency",
      target: "@example/leaf@9.9.9",
      relation: "dependencies",
      count: 1,
      consumers: ["@example/stem@2.0.0"],
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a published workspace protocol as a release defect even when a latest release exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { pin: "workspace:*" });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, [{
      kind: "local-only-internal-dependency-protocol",
      from: "@example/stem@2.0.0",
      to: "@example/leaf@workspace:*",
      relation: "dependencies",
      constraint: "workspace:*",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps exact latest and external dependencies as ordinary graph edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.equal(graph.observations.length, 0);
    assert.deepEqual(graph.tiers.dependency.edges.find((edge) => edge.to === "@example/leaf@1.0.0"), {
      from: "@example/stem@2.0.0",
      to: "@example/leaf@1.0.0",
      constraint: "1.0.0",
      relation: "dependencies",
      resolution: "registry",
    });
    assert.deepEqual(graph.tiers.dependency.edges.find((edge) => edge.to === "typescript"), {
      from: "@example/stem@2.0.0",
      to: "typescript",
      constraint: "^5.8.0",
      relation: "devDependencies",
      resolution: "external",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a published nonlatest superseded release in the history tier", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { supersedes: { package: "@example/leaf", version: "0.9.0" } });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.equal(graph.defects.length, 0);
    assert.deepEqual(graph.tiers.history.edges, [{
      from: "@example/stem@2.0.0",
      to: "@example/leaf@0.9.0",
      relation: "supersedes",
      resolution: "available-nonlatest-internal-release",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
