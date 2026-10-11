import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { freezeJson } from "@red-cup-engineering/json-services-section";
import { semanticIdOf } from "@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity";

const RECEIPT_KIND = "node-package-source-catalog.receipt";

const semanticId = semanticIdOf(RECEIPT_KIND);

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function runtimeDependencies(manifest) {
  const dependencies = new Map(Object.entries(manifest.dependencies ?? {})
    .map(([name, requested]) => [name, { name, requested, optional: false }]));
  for (const [name, requested] of Object.entries(manifest.optionalDependencies ?? {})) {
    dependencies.set(name, { name, requested, optional: true });
  }
  for (const [name, requested] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, { name, requested, optional: manifest.peerDependenciesMeta?.[name]?.optional === true });
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function packageDirectoryFrom(start, name) {
  let cursor = resolve(start);
  const segments = name.split("/");
  for (;;) {
    const candidate = join(cursor, "node_modules", ...segments);
    if (await exists(join(candidate, "package.json"))) return realpath(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function observePackage(directory) {
  const sourceDirectory = await realpath(directory);
  const manifestPath = join(sourceDirectory, "package.json");
  const content = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(content);
  if (typeof manifest.name !== "string" || manifest.name.length === 0) throw new Error(`package source ${sourceDirectory} has no identity`);
  if (typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error(`package source ${manifest.name} has no version`);
  return { sourceDirectory, manifestPath, manifest, manifestIdentity: semanticId({ path: manifestPath, content }) };
}

/**
 * Project the installed dependency graph as one identity-indexed provider
 * catalog. Resolution is rooted at the entry membrane first, so one package
 * identity has one current provider throughout the fabricated carrier; a
 * consumer-local installation is only consulted when the entry has no such
 * provider. Conflicting requests remain carried as normalization observations.
 *
 * The receipt is the `NodePackageSourceCatalogReceipt` v1 that
 * `materializeNodeRuntimeRelease` admits, so producer and consumer of that one
 * contract stay in this package.
 *
 * @param {{entryPackageDirectory: string, providerSources?: Record<string, string>}} request Entry membrane and any explicitly claimed provider directories.
 * @returns {Promise<object>} A frozen NodePackageSourceCatalogReceipt v1.
 */
export async function catalogNodePackageSources({ entryPackageDirectory, providerSources = {} }) {
  const entry = await observePackage(entryPackageDirectory);
  const selected = new Map([[entry.manifest.name, entry]]);
  for (const [name, directory] of Object.entries(providerSources)) {
    const provider = await observePackage(directory);
    if (provider.manifest.name !== name) throw new Error(`provider source claim ${name} carries ${provider.manifest.name}`);
    selected.set(name, provider);
  }
  const queue = [entry];
  for (const provider of selected.values()) if (provider !== entry) queue.push(provider);
  const requests = [];
  const optionalProviderAbsences = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const consumer = queue[cursor];
    for (const { name, requested, optional } of runtimeDependencies(consumer.manifest)) {
      let provider = selected.get(name);
      if (!provider) {
        const sourceDirectory = providerSources[name]
          ?? await packageDirectoryFrom(entry.sourceDirectory, name)
          ?? await packageDirectoryFrom(consumer.sourceDirectory, name);
        if (!sourceDirectory && optional) {
          optionalProviderAbsences.push({ consumer: consumer.manifest.name, provider: name, requested });
          continue;
        }
        if (!sourceDirectory) throw new Error(`runtime dependency ${name} requested by ${consumer.manifest.name} has no observable provider source`);
        provider = await observePackage(sourceDirectory);
        if (provider.manifest.name !== name) throw new Error(`provider source for ${name} carries ${provider.manifest.name}`);
        selected.set(name, provider);
        queue.push(provider);
      }
      requests.push({ consumer: consumer.manifest.name, provider: name, requested, selected: provider.manifest.version });
    }
  }
  const packages = [...selected.values()].map(({ sourceDirectory, manifest, manifestIdentity }) => ({
    name: manifest.name,
    version: manifest.version,
    sourceDirectory,
    manifestEvidence: manifestIdentity,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const body = {
    type: "NodePackageSourceCatalogReceipt",
    version: 1,
    entryPackage: entry.manifest.name,
    packages,
    requests: requests.sort((left, right) => left.consumer.localeCompare(right.consumer) || left.provider.localeCompare(right.provider)),
    optionalProviderAbsences: optionalProviderAbsences.sort((left, right) => left.consumer.localeCompare(right.consumer) || left.provider.localeCompare(right.provider)),
  };
  return freezeJson({ ...body, id: semanticId(body) });
}
