import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import { makeNiUri, isNiUri } from "@red-cup-engineering/semiotic-content-address-system";
import { observeJsnodePackageBody } from "@red-cup-engineering/jsnode-package-body-observation-service";
import { normalizeJsnodePackageDependencies } from "@red-cup-engineering/jsnode-package-dependency-normalization-service";
import { normalizeJsnodePackageIdentity } from "@red-cup-engineering/jsnode-package-identity-normalization-service";
import { normalizeJsnodePackageManifest } from "@red-cup-engineering/npm-package-manifest-normalization-service";
import { projectJsnodePackageOwner } from "@red-cup-engineering/jsnode-package-owner-projection-service";
import { openNpmRegistry, readNpmPackument } from "@red-cup-engineering/npm-registry-engineering-services-section/read-npm-registry-resource";
import { readNpmRegistryConfiguration, registryForPackage } from "./registry-configuration.mjs";
import { planModuleRequests, readSource, receiveInputs, replacePlannedSources, requireSourcePath } from "./normalization-source.mjs";

const PLAN = "NpmPackageNormalizationPlan";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const localDependency = value => typeof value === "string" && /^(?:workspace:|file:|link:)/u.test(value);
const exactVersion = value => typeof value === "string" && /^\d/u.test(value) && value.trim() === value && semver.valid(value) !== null;
const registryRange = value => typeof value === "string" && semver.validRange(value) !== null;
const object = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const textOf = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

async function registryMetadata(bindings, fetchImplementation, signal) {
  const metadata = new Map();
  const names = Object.keys(bindings);
  for (let offset = 0; offset < names.length; offset += 6) {
    await Promise.all(names.slice(offset, offset + 6).map(async name => {
      const registry = bindings[name];
      try {
        signal.throwIfAborted();
        const reader = openNpmRegistry({ registryUrl: registry, fetchImplementation: url => fetchImplementation(url, { signal }) });
        const document = await readNpmPackument(reader, name);
        if (document !== null && document.value.name !== name) throw new Error("registry document identity differs from the selected package");
        metadata.set(name, document === null
          ? { status: "missing", registry }
          : { status: "observed", registry, value: document.value, ni: makeNiUri(document.bytes) });
      } catch (error) {
        metadata.set(name, { status: "unread", registry, reason: String(error?.message ?? error).slice(0, 300) });
      }
    }));
  }
  return metadata;
}

function releaseFor(document, name, version) {
  if (!exactVersion(version)) return undefined;
  const release = document.value?.versions?.[version];
  if (release?.name === name && release.version === version
    && typeof release.dist?.integrity === "string" && release.dist.integrity
    && typeof release.dist?.tarball === "string" && release.dist.tarball) return release;
  return undefined;
}

/** Plan package and module changes from explicit owned source and registry metadata. */
export async function planNpmPackageNormalization({
  root, manifestPaths = ["package.json"], owner, registry,
  signal = AbortSignal.timeout(15000), fetchImplementation = fetch,
  registryConfigurationImplementation = readNpmRegistryConfiguration,
} = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("name the selected owned source root");
  if (typeof fetchImplementation !== "function" || typeof registryConfigurationImplementation !== "function" || typeof signal?.throwIfAborted !== "function") {
    throw new TypeError("callable fetchImplementation, registryConfigurationImplementation and AbortSignal required");
  }
  if (!Array.isArray(manifestPaths) || manifestPaths.length === 0) throw new TypeError("explicit package manifests required");
  const selected = [...new Set(manifestPaths)].sort();
  for (const path of selected) {
    requireSourcePath(path);
    if (basename(path) !== "package.json") throw new TypeError("select package.json files relative to the source root");
  }

  const absoluteRoot = await realpath(root);
  const snapshots = new Map();
  const snapshot = async (path, missing = false) => {
    const value = await readSource(absoluteRoot, path, { missing });
    snapshots.set(path, value.ni);
    return value;
  };
  await snapshot(".npmrc", true);
  const originals = new Map();
  for (const path of selected) originals.set(path, JSON.parse(textOf((await snapshot(path)).bytes)));
  const { packages, sourceFiles } = await observeJsnodePackageBody({ root: absoluteRoot, manifestPaths: selected });
  const configuration = await registryConfigurationImplementation({ root: absoluteRoot, registry, signal });

  const failures = [], requirements = [], rows = [], changes = [];
  let registryBindings = {};
  const result = () => Object.freeze({
    type: PLAN, version: 1, root: absoluteRoot, ready: failures.length === 0, applied: false, packages: packages.length,
    registry: configuration.registry, registryOverride: registry ?? null, registryBindings,
    ownerBindings: rows.map(({ path, identity }) => ({ path, owner: identity.owner, basis: owner === undefined ? "section-projection" : "explicit" })),
    manifestFilesChanged: changes.filter(change => change.kind === "manifest").length,
    consumerFilesChanged: changes.filter(change => change.kind === "source").length,
    identitiesChanged: rows.filter(({ identity }) => identity.priorName !== identity.name).length,
    inputs: [...snapshots].map(([path, ni]) => ({ path, ni })),
    requirements, failures, changes,
  });
  const observedPaths = new Set(packages.map(item => item.path));
  for (const path of selected) {
    if (!observedPaths.has(path)) failures.push({ kind: "package-identity", path, reason: "selected manifest requires an explicit package name" });
  }
  const priorNames = new Set(), names = new Set();
  for (const { path, manifest } of packages) {
    try {
      if (!isDeepStrictEqual(originals.get(path), manifest)) throw new Error("manifest changed during observation");
      if (priorNames.has(manifest.name)) throw new TypeError("selected source identities must be unique");
      priorNames.add(manifest.name);
      const namespace = owner === undefined ? projectJsnodePackageOwner(resolve(absoluteRoot, path)).owner : owner;
      const identity = normalizeJsnodePackageIdentity({ packageName: manifest.name, owner: namespace });
      if (names.has(identity.name)) throw new TypeError("normalized source identities must be unique");
      names.add(identity.name);
      if (!exactVersion(manifest.version)) {
        failures.push({ kind: "package-version", path, version: manifest.version ?? null, reason: "source requires an explicit exact semantic version" });
        continue;
      }
      const normalized = normalizeJsnodePackageManifest({ manifest, identity });
      if (normalized.version !== manifest.version) throw new Error("manifest provider must preserve the exact admitted source version");
      rows.push({ path, manifest, normalized, identity });
    } catch (error) {
      failures.push({ kind: "package-identity", path, reason: error.message });
    }
  }
  if (failures.length) return result();

  const providersByName = new Map(rows.map(({ identity }) => [identity.priorName, identity]));
  const providersByDirectory = new Map(rows.map(({ path, identity }) => [dirname(resolve(absoluteRoot, path)), identity]));
  const requests = [];
  for (const { path, manifest } of rows) {
    for (const field of DEPENDENCY_FIELDS) {
      if (manifest[field] !== undefined && !object(manifest[field])) {
        failures.push({ kind: "dependency-field", path, field, reason: "dependency fields require a name/specification object" });
        continue;
      }
      for (const [name, specification] of Object.entries(manifest[field] ?? {})) {
        const localPath = typeof specification === "string" ? /^(?:file:|link:)(.+)$/u.exec(specification) : null;
        const selectedProvider = (localPath && providersByDirectory.get(resolve(dirname(resolve(absoluteRoot, path)), localPath[1]))) || providersByName.get(name);
        const selection = localDependency(specification) ? "latest" : specification;
        const request = { kind: "registry-dependency", path, field, name, provider: selectedProvider?.name ?? name, specification, selection };
        if (localDependency(specification) || registryRange(specification)) requests.push(request);
        else {
          const requirement = { ...request, status: "registry-range-required", reason: "dependency requires a registry version range" };
          requirements.push(requirement);
          failures.push(requirement);
        }
      }
    }
  }

  const requested = [...new Set([...names, ...requests.map(request => request.provider)])].sort();
  registryBindings = Object.fromEntries(requested.map(name => [name, registryForPackage(configuration, name)]));
  const metadata = await registryMetadata(registryBindings, fetchImplementation, signal);
  const registryReleases = new Map();
  for (const [name, document] of metadata) {
    const release = releaseFor(document, name, document.value?.["dist-tags"]?.latest);
    if (release !== undefined) registryReleases.set(name, release);
  }
  for (const request of requests) {
    const document = metadata.get(request.provider);
    const version = localDependency(request.specification)
      ? document.value?.["dist-tags"]?.latest
      : semver.maxSatisfying(Object.keys(document.value?.versions ?? {}), request.specification);
    const release = releaseFor(document, request.provider, version);
    if (release) {
      requirements.push({ ...request, registry: document.registry, status: "metadata-observed", version,
        integrity: release.dist.integrity, tarball: release.dist.tarball, packument: document.ni, publishedAt: document.value.time?.[version] ?? null });
    } else {
      const reason = localDependency(request.specification)
        ? "the exact required registry release has not been observed"
        : `no published registry release satisfies range ${JSON.stringify(request.specification)}`;
      const requirement = { ...request, registry: document.registry, status: document.status === "unread" ? "unread" : "unpublished", reason: document.reason ?? reason };
      requirements.push(requirement);
      failures.push(requirement);
    }
  }
  if (failures.length) return result();

  const renamedPackages = new Map(rows.filter(({ identity }) => identity.priorName !== identity.name)
    .map(({ identity }) => [identity.priorName, identity.name]));
  const byPath = new Map(rows.map(row => [row.path, row]));
  const carriers = rows.map(({ path, identity }) => ({ path, directory: dirname(path), name: identity.name, registryRelease: registryReleases.get(identity.name) }));
  const change = (path, content, kind) => ({ path, content, kind, before: snapshots.get(path), after: makeNiUri(Buffer.from(content)) });
  for (const path of sourceFiles) {
    try {
      const before = textOf((await snapshot(path)).bytes);
      const { text, dependencies } = await planModuleRequests({ root: absoluteRoot, path, text: before, carriers, renamedPackages });
      for (const { consumerPath, consumerDependencies } of dependencies) {
        const consumer = byPath.get(consumerPath);
        consumer.normalized = { ...consumer.normalized, dependencies: { ...consumer.normalized.dependencies, ...consumerDependencies } };
      }
      if (text !== before) changes.push(change(path, text, "source"));
    } catch (error) {
      failures.push({ kind: "module-edge", path, reason: error.message });
    }
  }
  for (const { path, manifest, normalized } of rows) {
    const after = normalizeJsnodePackageDependencies({ manifest: normalized, manifestPath: path, root: absoluteRoot, providersByName, providersByDirectory, registryReleases });
    if (!isDeepStrictEqual(manifest, after)) changes.push(change(path, JSON.stringify(after, null, 2) + "\n", "manifest"));
  }
  return result();
}

/** Apply a ready plan to its selected source after receiving the exact observed inputs again. */
export async function applyNpmPackageNormalization({ root, plan } = {}) {
  if (typeof root !== "string" || !root || plan?.type !== PLAN || plan.version !== 1
    || plan.ready !== true || plan.applied !== false || !Array.isArray(plan.failures) || plan.failures.length
    || !Array.isArray(plan.requirements) || !Array.isArray(plan.inputs)
    || !Array.isArray(plan.changes) || !object(plan.registryBindings)) {
    throw new TypeError("an explicit source root and ready npm package normalization plan are required");
  }
  const absoluteRoot = await realpath(root);
  if (plan.root !== absoluteRoot) throw new TypeError("plan belongs to a different source root");
  const inputs = new Map();
  for (const { path, ni } of plan.inputs) {
    requireSourcePath(path);
    if (inputs.has(path) || (!isNiUri(ni) && !(path === ".npmrc" && ni === null))) throw new TypeError("plan inputs require unique addressed source paths");
    inputs.set(path, ni);
  }
  if (!inputs.has(".npmrc")) throw new TypeError("plan inputs must bind project registry configuration");
  const changed = new Set();
  for (const { path, before, after, content, kind } of plan.changes) {
    if (changed.has(path) || !isNiUri(before) || before !== inputs.get(path)
      || !["manifest", "source"].includes(kind) || (basename(path) === "package.json") !== (kind === "manifest")
      || path === ".npmrc" || typeof content !== "string" || makeNiUri(Buffer.from(content)) !== after) {
      throw new TypeError("changes must bind unique observed preimages and exact resulting bytes");
    }
    changed.add(path);
  }

  const received = await receiveInputs(absoluteRoot, inputs);
  const { failures } = received;
  const refused = () => Object.freeze({ ...plan, ready: false, applied: false, failures });
  if (failures.length) return refused();
  const configuration = await readNpmRegistryConfiguration({
    root: absoluteRoot, registry: plan.registryOverride ?? undefined, signal: AbortSignal.timeout(15000),
  });
  for (const [name, expected] of Object.entries(plan.registryBindings)) {
    if (registryForPackage(configuration, name) !== expected) {
      failures.push({ kind: "registry-changed", name, reason: "npm registry selection differs from the received plan" });
    }
  }
  if (failures.length) return refused();
  failures.push(...await replacePlannedSources(absoluteRoot, inputs, plan.changes, received.observed));
  return failures.length ? refused() : Object.freeze({ ...plan, applied: true });
}
