import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const RECEIPT_TYPE = "SemioticVoxelPackageRegistryReceipt";

function registryFace(registryUrl) {
  const url = new URL(registryUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("registry URL must be HTTP(S)");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

// A read source answering exactly two questions — "the receipt" and "the
// packument for this name, or null if there isn't one" — is every query in
// this module needs. Absence is a value here, never a thrown ENOENT: that
// distinction is this service's whole reason to exist (see defect 2 in the
// npm registry local-first hardening record).
function diskSource(registryRoot) {
  const root = resolve(registryRoot);
  return {
    registry: root,
    async receipt() {
      return JSON.parse(await readFile(join(root, "registry-receipt.json"), "utf8"));
    },
    async packument(name) {
      try {
        return JSON.parse(await readFile(join(root, "metadata", `${encodeURIComponent(name)}.json`), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function liveSource(registryUrl, fetchImplementation) {
  const face = registryFace(registryUrl);
  return {
    registry: face,
    async receipt() {
      const response = await fetchImplementation(new URL("registry-receipt.json", face));
      if (!response.ok) throw new Error(`registry face does not publish registry-receipt.json: HTTP ${response.status}`);
      return response.json();
    },
    async packument(name) {
      const response = await fetchImplementation(new URL(encodeURIComponent(name), face));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`registry face refused a packument request for ${name}: HTTP ${response.status}`);
      return response.json();
    },
  };
}

function source({ registryRoot, registryUrl, fetchImplementation = fetch }) {
  if ((registryRoot === undefined) === (registryUrl === undefined)) {
    throw new TypeError("supply exactly one of registryRoot (directory) or registryUrl (HTTP face)");
  }
  return registryUrl === undefined ? diskSource(registryRoot) : liveSource(registryUrl, fetchImplementation);
}

// Does this registry admit a packument for `name`? A clean boolean, never a
// crash — the absence of a package is an ordinary answer, not an exceptional
// one.
export async function packageExists(options) {
  const { name } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const face = source(options);
  const packument = await face.packument(name);
  return Object.freeze({ type: "NpmPackageExistenceAnswer", registry: face.registry, name, exists: packument !== null });
}

// Every distinct package name this registry's receipt admits, filtered by a
// case-insensitive substring or an explicit RegExp — a search, not a filter
// that throws when its input doesn't match: an empty result is a legitimate
// answer.
export async function searchPackages(options) {
  const { pattern } = options;
  if (typeof pattern !== "string" && !(pattern instanceof RegExp)) throw new TypeError("pattern must be a string or RegExp");
  const face = source(options);
  const receipt = await face.receipt();
  if (receipt?.type !== RECEIPT_TYPE || !Array.isArray(receipt.packages)) throw new Error("registry has no recognized build receipt");
  const names = [...new Set(receipt.packages.map((entry) => entry.name))].sort();
  const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
  const matches = names.filter((name) => matcher.test(name));
  return Object.freeze({ type: "NpmPackageSearchAnswer", registry: face.registry, pattern: String(pattern), matches: Object.freeze(matches) });
}

function dependencyMap(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  };
}

async function resolvedVersion(face, name, version) {
  const packument = await face.packument(name);
  if (packument === null) return { packument: null, version: null, manifest: null };
  const selected = version ?? packument["dist-tags"]?.latest;
  const manifest = selected === undefined ? undefined : packument.versions?.[selected];
  return { packument, version: selected ?? null, manifest: manifest ?? null };
}

// What does name@version (default: dist-tags.latest) declare as a dependency?
// A clean "package not found" or "version not found" answer, never a crash.
export async function dependenciesOf(options) {
  const { name, version } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const face = source(options);
  const resolved = await resolvedVersion(face, name, version);
  if (resolved.manifest === null) {
    return Object.freeze({ type: "NpmPackageDependenciesAnswer", registry: face.registry, name, version: version ?? null, found: false, dependencies: Object.freeze([]) });
  }
  const dependencies = Object.entries(dependencyMap(resolved.manifest)).sort(([a], [b]) => a.localeCompare(b))
    .map(([dependency, constraint]) => Object.freeze({ name: dependency, constraint }));
  return Object.freeze({ type: "NpmPackageDependenciesAnswer", registry: face.registry, name, version: resolved.version, found: true, dependencies: Object.freeze(dependencies) });
}

// Who, among this registry's own receipt entries, directly depends on `name`?
// This only ever answers over a registry that has a receipt (the "ours" set
// registry-graph.mjs itself uses for the no-argument case) — a live third-party
// registry has no bounded universe to scan.
export async function dependentsOf(options) {
  const { name } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const face = source(options);
  const receipt = await face.receipt();
  if (receipt?.type !== RECEIPT_TYPE || !Array.isArray(receipt.packages)) throw new Error("registry has no recognized build receipt; dependents can only be found within a registry this house built");
  const dependents = [];
  const seen = new Set();
  for (const entry of receipt.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const packument = await face.packument(entry.name);
    const manifest = packument?.versions?.[entry.version];
    if (!manifest) continue;
    const constraint = dependencyMap(manifest)[name];
    if (constraint !== undefined) dependents.push(Object.freeze({ name: entry.name, version: entry.version, constraint }));
  }
  dependents.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return Object.freeze({ type: "NpmPackageDependentsAnswer", registry: face.registry, name, dependents: Object.freeze(dependents) });
}
