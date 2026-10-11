import {
  deriveRegistryGraph as defaultDeriveRegistryGraph,
  groupRegistryGraphDefects as defaultGroupRegistryGraphDefects,
  renderRegistryGraphDot as defaultRenderRegistryGraphDot,
} from "@red-cup-engineering/npm-registry-graph-services-section";

import { deriveInternalRegistryScopes } from "./internal-registry-scopes.mjs";

function catalogUrl(registryUrl) {
  return `${registryUrl.replace(/\/+$/u, "")}/-/verdaccio/data/packages`;
}

/**
 * List every package name this live registry currently serves, at whatever
 * version `dist-tags.latest` names — the same "ordinary Verdaccio, ordinary
 * endpoint" catalog source the deleted Makefile's registry-audit target read
 * with curl, kept here as one injectable step instead of a shell pipeline.
 */
export async function fetchNpmRegistryCatalog({ registryUrl, fetchImplementation = fetch }) {
  if (typeof registryUrl !== "string" || registryUrl.length === 0) throw new TypeError("registryUrl is required");
  const response = await fetchImplementation(catalogUrl(registryUrl));
  if (!response.ok) throw new Error(`registry catalog request failed: ${response.status} ${response.statusText}`);
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error("registry catalog response was not an array");
  const names = [...new Set(entries.map((entry) => entry?.name).filter((name) => typeof name === "string" && name.length > 0))];
  return Object.freeze(names.sort());
}

/**
 * Derive the registry dependency graph from the live catalog and Verdaccio's
 * own config.yaml — the single declared source of which scopes are internal
 * — and render every artifact the old `make registry-audit` target wrote,
 * from one graph derivation instead of three redundant ones.
 */
export async function runNpmRegistryAudit({
  registryUrl,
  configYamlText,
  fetchImplementation = fetch,
  deriveRegistryGraph = defaultDeriveRegistryGraph,
  renderRegistryGraphDot = defaultRenderRegistryGraphDot,
  groupRegistryGraphDefects = defaultGroupRegistryGraphDefects,
} = {}) {
  if (typeof registryUrl !== "string" || registryUrl.length === 0) throw new TypeError("registryUrl is required");
  if (typeof configYamlText !== "string" || configYamlText.length === 0) throw new TypeError("configYamlText is required");

  const internalScopes = deriveInternalRegistryScopes(configYamlText);
  if (internalScopes.length === 0) throw new Error("config.yaml declared no internal scopes; refusing to audit against an empty scope set");

  const packages = await fetchNpmRegistryCatalog({ registryUrl, fetchImplementation });
  if (packages.length === 0) throw new Error(`registry catalog at ${registryUrl} is empty`);

  const graph = await deriveRegistryGraph({ registryUrl, packages, internalScopes, fetchImplementation });
  const defectGroups = groupRegistryGraphDefects(graph.defects);
  const latestSetDivergenceGroups = groupRegistryGraphDefects(graph.observations ?? []);
  const summary = {
    type: graph.type,
    registry: graph.registry,
    receiptSha256: graph.receiptSha256,
    internalScopes,
    packagesAudited: packages.length,
    nodes: graph.nodes.length,
    dependencyEdges: graph.tiers.dependency.edges.length,
    history: graph.tiers.history,
    defects: graph.defects.length,
    defectGroups: defectGroups.map(({ consumers: _consumers, ...group }) => group),
    // A divergence is a real migration/release-planning fact, but exact
    // registry metadata says npm can obtain the requested release. Keep it
    // out of the install-resolution gate.
    latestSetDivergences: (graph.observations ?? []).length,
    latestSetDivergenceGroups: latestSetDivergenceGroups.map(({ consumers: _consumers, ...group }) => group),
  };

  return Object.freeze({
    graph,
    internalScopes,
    artifacts: Object.freeze({
      json: `${JSON.stringify(graph, null, 2)}\n`,
      dot: renderRegistryGraphDot(graph, { tier: "dependency" }),
      summary,
    }),
    defectCount: graph.defects.length,
    ok: graph.defects.length === 0,
  });
}
