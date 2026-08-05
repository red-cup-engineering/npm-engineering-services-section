#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPackageRegistry } from "../src/package-registry.mjs";
import { deriveRegistryGraph, renderRegistryGraphDot } from "../src/registry-graph.mjs";

function option(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    if (!required) return undefined;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

const directPackages = process.argv.flatMap((value, index) => value === "--package" && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const excludedBaseReleases = process.argv.flatMap((value, index) => value === "--exclude-base-release" && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const packageList = option("--packages", { required: false });
if (packageList !== undefined && directPackages.length > 0) throw new Error("supply either --packages or one or more --package values");
if (packageList === undefined && directPackages.length === 0 && excludedBaseReleases.length === 0) throw new Error("supply packages or one or more --exclude-base-release values");
const packageDirectories = packageList === undefined ? directPackages : JSON.parse(await readFile(packageList, "utf8"));
const outputDirectory = option("--output");
const registryUrl = option("--registry-url");
const receipt = await buildPackageRegistry({
  packageDirectories,
  outputDirectory,
  registryUrl,
  baseRegistryDirectory: option("--base-registry", { required: false }),
  excludedBaseReleases,
});
const graph = await deriveRegistryGraph({ registryRoot: outputDirectory });
const graphDirectory = join(outputDirectory, "graph");
await mkdir(graphDirectory, { recursive: true });
await Promise.all([
  writeFile(join(graphDirectory, "npm-registry-graph.json"), `${JSON.stringify(graph, null, 2)}\n`),
  writeFile(join(graphDirectory, "dependency-tier.dot"), renderRegistryGraphDot(graph, { tier: "dependency" })),
]);
process.stdout.write(`${JSON.stringify({ type: receipt.type, registry: receipt.registry, packages: receipt.packageCount, releases: receipt.packages.length, scopes: receipt.scopes.length, compute: receipt.compute }, null, 2)}\n`);
