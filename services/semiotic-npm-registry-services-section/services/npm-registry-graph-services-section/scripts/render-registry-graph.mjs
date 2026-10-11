#!/usr/bin/env node
import { deriveRegistryGraph, groupRegistryGraphDefects, renderRegistryGraphDot } from "../src/registry-graph.mjs";

function option(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    if (!required) return undefined;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function repeated(name) {
  return process.argv.flatMap((value, index) => (value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []));
}

const registry = option("--registry");
const packages = repeated("--package");
const internalScopes = repeated("--internal-scope");
const graph = await deriveRegistryGraph({
  ...(/^https?:\/\//u.test(registry) ? { registryUrl: registry } : { registryRoot: registry }),
  ...(packages.length > 0 ? { packages } : {}),
  ...(internalScopes.length > 0 ? { internalScopes } : {}),
});
const format = option("--format", { required: false }) ?? "summary";
const allowDefects = process.argv.includes("--allow-defects");
const defectGroups = groupRegistryGraphDefects(graph.defects);
const latestSetDivergenceGroups = groupRegistryGraphDefects(graph.observations ?? []);
if (format === "json") {
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
} else if (format === "dot") {
  process.stdout.write(renderRegistryGraphDot(graph, { tier: option("--tier", { required: false }) ?? "dependency" }));
} else if (format === "edges") {
  const tier = option("--tier", { required: false }) ?? "dependency";
  for (const edge of graph.tiers[tier]?.edges ?? []) {
    process.stdout.write(`${edge.from}\t${edge.relation}\t${edge.to}\n`);
  }
} else if (format === "summary") {
  process.stdout.write(`${JSON.stringify({
    type: graph.type,
    registry: graph.registry,
    receiptSha256: graph.receiptSha256,
    nodes: graph.nodes.length,
    dependencyEdges: graph.tiers.dependency.edges.length,
    history: graph.tiers.history,
    defects: graph.defects.length,
    defectGroups: defectGroups.map(({ consumers: _consumers, ...group }) => group),
    latestSetDivergences: (graph.observations ?? []).length,
    latestSetDivergenceGroups: latestSetDivergenceGroups.map(({ consumers: _consumers, ...group }) => group),
  }, null, 2)}\n`);
} else {
  throw new Error(`unknown --format: ${format}`);
}
if (graph.defects.length > 0 && !allowDefects) {
  for (const group of defectGroups) {
    process.stderr.write(`registry graph defect group: ${group.kind} -> ${group.target} (${group.relation}); ${group.count} consumer(s)\n`);
  }
  process.exitCode = 1;
}
