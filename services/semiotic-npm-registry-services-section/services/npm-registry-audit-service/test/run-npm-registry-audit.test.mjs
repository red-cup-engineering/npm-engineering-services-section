import assert from "node:assert/strict";
import test from "node:test";

import { fetchNpmRegistryCatalog, runNpmRegistryAudit } from "../src/run-npm-registry-audit.mjs";

const REGISTRY_URL = "http://127.0.0.1:4873";

const CONFIG_WITHOUT_COESITE_OPERATIONS = `packages:
  '@561-group/*': &private_packages
    access: $all
  '@red-cup-engineering/*': *private_packages
`;

const CONFIG_WITH_COESITE_OPERATIONS = `packages:
  '@561-group/*': &private_packages
    access: $all
  '@coesite-operations/*': *private_packages
  '@red-cup-engineering/*': *private_packages
`;

function catalogFetch(names) {
  return async (url) => {
    assert.equal(url, `${REGISTRY_URL}/-/verdaccio/data/packages`);
    return new Response(JSON.stringify(names.map((name) => ({ name }))), { status: 200 });
  };
}

// A minimal double for deriveRegistryGraph that reports one unresolved
// dependency on an `@coesite-operations` package precisely when that scope is
// absent from `internalScopes` — the same shape the real graph service
// reports for a scope missing from an audited registry's declared internal
// set, so this test proves the orchestration wires scope derivation into the
// gate, not just that the parser returns the right strings in isolation.
function fakeDeriveRegistryGraph({ registryUrl, packages, internalScopes }) {
  const coesiteResolved = internalScopes.includes("coesite-operations");
  const defects = coesiteResolved
    ? []
    : [{ kind: "unresolved-dependency", target: "@coesite-operations/witness@1.0.0", relation: "dependencies", consumer: "@red-cup-engineering/consumer@1.0.0" }];
  return {
    type: "NpmRegistryGraph",
    registry: registryUrl,
    receiptSha256: null,
    nodes: packages.map((name) => ({ name })),
    tiers: { dependency: { edges: [] }, history: { edges: [] } },
    defects,
  };
}

function fakeGroupRegistryGraphDefects(defects) {
  return defects.map((defect) => ({ ...defect, count: 1, consumers: [defect.consumer] }));
}

function fakeRenderRegistryGraphDot(graph) {
  return `digraph { /* ${graph.nodes.length} nodes */ }\n`;
}

test("reports latest-set divergence separately and does not fail the exact-resolution gate", async () => {
  const result = await runNpmRegistryAudit({
    registryUrl: REGISTRY_URL,
    configYamlText: CONFIG_WITH_COESITE_OPERATIONS,
    fetchImplementation: catalogFetch(["@red-cup-engineering/consumer"]),
    deriveRegistryGraph: ({ registryUrl, packages }) => ({
      type: "NpmRegistryGraph",
      registry: registryUrl,
      receiptSha256: null,
      nodes: packages.map((name) => ({ name })),
      tiers: { dependency: { edges: [] }, history: { edges: [] } },
      observations: [{
        kind: "available-nonlatest-internal-dependency",
        from: "@red-cup-engineering/consumer@1.0.0",
        to: "@red-cup-engineering/provider@1.0.0",
        relation: "dependencies",
      }],
      defects: [],
    }),
    renderRegistryGraphDot: fakeRenderRegistryGraphDot,
    groupRegistryGraphDefects: fakeGroupRegistryGraphDefects,
  });
  assert.equal(result.ok, true);
  assert.equal(result.defectCount, 0);
  assert.equal(result.artifacts.summary.latestSetDivergences, 1);
  assert.equal(result.artifacts.summary.latestSetDivergenceGroups[0].to, "@red-cup-engineering/provider@1.0.0");
});

test("gates on defects when the audited registry's config.yaml omits a live internal scope", async () => {
  const result = await runNpmRegistryAudit({
    registryUrl: REGISTRY_URL,
    configYamlText: CONFIG_WITHOUT_COESITE_OPERATIONS,
    fetchImplementation: catalogFetch(["@red-cup-engineering/consumer", "@coesite-operations/witness"]),
    deriveRegistryGraph: fakeDeriveRegistryGraph,
    renderRegistryGraphDot: fakeRenderRegistryGraphDot,
    groupRegistryGraphDefects: fakeGroupRegistryGraphDefects,
  });
  assert.equal(result.ok, false);
  assert.equal(result.defectCount, 1);
  assert.equal(result.artifacts.summary.defectGroups[0].target, "@coesite-operations/witness@1.0.0");
});

test("clears the same defect once config.yaml declares the scope", async () => {
  const result = await runNpmRegistryAudit({
    registryUrl: REGISTRY_URL,
    configYamlText: CONFIG_WITH_COESITE_OPERATIONS,
    fetchImplementation: catalogFetch(["@red-cup-engineering/consumer", "@coesite-operations/witness"]),
    deriveRegistryGraph: fakeDeriveRegistryGraph,
    renderRegistryGraphDot: fakeRenderRegistryGraphDot,
    groupRegistryGraphDefects: fakeGroupRegistryGraphDefects,
  });
  assert.equal(result.ok, true);
  assert.equal(result.defectCount, 0);
  assert.equal(result.internalScopes.includes("coesite-operations"), true);
});

test("writes the graph JSON and DOT artifacts and the packages-audited count into the summary", async () => {
  const result = await runNpmRegistryAudit({
    registryUrl: REGISTRY_URL,
    configYamlText: CONFIG_WITH_COESITE_OPERATIONS,
    fetchImplementation: catalogFetch(["@red-cup-engineering/consumer", "@coesite-operations/witness"]),
    deriveRegistryGraph: fakeDeriveRegistryGraph,
    renderRegistryGraphDot: fakeRenderRegistryGraphDot,
    groupRegistryGraphDefects: fakeGroupRegistryGraphDefects,
  });
  // fetchNpmRegistryCatalog sorts the catalog, so nodes arrive alphabetically.
  assert.deepEqual(JSON.parse(result.artifacts.json).nodes, [{ name: "@coesite-operations/witness" }, { name: "@red-cup-engineering/consumer" }]);
  assert.match(result.artifacts.dot, /^digraph \{/u);
  assert.equal(result.artifacts.summary.packagesAudited, 2);
});

test("refuses to audit against an empty declared-scope set", async () => {
  await assert.rejects(
    runNpmRegistryAudit({
      registryUrl: REGISTRY_URL,
      configYamlText: "storage: ../../data/storage\n",
      fetchImplementation: catalogFetch(["@red-cup-engineering/consumer"]),
      deriveRegistryGraph: fakeDeriveRegistryGraph,
    }),
    /no internal scopes/u,
  );
});

test("fetchNpmRegistryCatalog dedupes and sorts catalog names", async () => {
  const names = await fetchNpmRegistryCatalog({
    registryUrl: REGISTRY_URL,
    fetchImplementation: catalogFetch(["@b/pkg", "@a/pkg", "@a/pkg"]),
  });
  assert.deepEqual(names, ["@a/pkg", "@b/pkg"]);
});

test("fetchNpmRegistryCatalog rejects a non-ok registry response", async () => {
  await assert.rejects(
    fetchNpmRegistryCatalog({
      registryUrl: REGISTRY_URL,
      fetchImplementation: async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
    }),
    /503/u,
  );
});

test("runNpmRegistryAudit rejects an empty catalog", async () => {
  await assert.rejects(
    runNpmRegistryAudit({
      registryUrl: REGISTRY_URL,
      configYamlText: CONFIG_WITH_COESITE_OPERATIONS,
      fetchImplementation: catalogFetch([]),
      deriveRegistryGraph: fakeDeriveRegistryGraph,
    }),
    /catalog.*empty/u,
  );
});
