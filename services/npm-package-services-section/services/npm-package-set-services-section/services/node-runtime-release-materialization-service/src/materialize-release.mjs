import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsnodeRuntimeModuleRequests } from "@red-cup-engineering/javascript-node-services-section/syntax";
import { resolve as resolveImport } from "import-meta-resolve";
import { dirname, join, relative, resolve, sep } from "node:path";
import { admitNpmTarballProvider } from "./admitted-npm-tarball.mjs";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";
export { materializeTracedNodeRuntime } from "./materialize-traced-node-runtime.mjs";

const OMIT_DIRECTORY = new Set([".git", "node_modules", "data", "test", "tests", "dist-tests", "benchmark", "benchmarks", "docs", "examples", "ops", ".tmp"]);
const BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false; throw error; }
}

async function copyTree(source, target) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (OMIT_DIRECTORY.has(entry.name)) continue;
      await copyTree(join(source, entry.name), join(target, entry.name));
    }
    return;
  }
  if (!info.isFile()) return;
  if (/\.(?:test|spec)\.[cm]?[jt]s$/u.test(source.split("/").at(-1))) return;
  if (/(?:^|[.-])(?:eslint|rollup|webpack|vite|vitest)\.config\.[cm]?[jt]s$/u.test(source.split("/").at(-1))) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
}

async function admittedSource(directory) {
  const canonical = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(canonical, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error(`provider source ${canonical} has no package identity`);
  if (!EXACT_VERSION.test(manifest.version ?? "")) throw new Error(`provider source ${manifest.name} has no exact version`);
  return { kind: "source", directory: canonical, manifest };
}

async function copyExactTree(source, target) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) await copyExactTree(join(source, entry.name), join(target, entry.name));
    await chmod(target, info.mode & 0o777);
    return;
  }
  if (!info.isFile()) throw new Error(`admitted tarball extracted an unsupported filesystem carrier at ${source}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await readFile(source));
  await chmod(target, info.mode & 0o777);
}

function runtimeDependencies(manifest) {
  const dependencies = new Map(Object.entries(manifest.dependencies ?? {})
    .map(([name, requested]) => [name, { field: "dependencies", name, requested, optional: false }]));
  for (const [name, requested] of Object.entries(manifest.optionalDependencies ?? {})) {
    dependencies.set(name, { field: "optionalDependencies", name, requested, optional: true });
  }
  for (const [name, requested] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, { field: "peerDependencies", name, requested, optional: manifest.peerDependenciesMeta?.[name]?.optional === true });
    }
  }
  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function copyPackage(source, target, manifest, entry = false) {
  await mkdir(target, { recursive: true });
  if (Array.isArray(manifest.files) && manifest.files.length > 0) {
    const positiveCarriers = manifest.files.filter((carrier) => typeof carrier === "string" && !carrier.startsWith("!"));
    const rootGlob = positiveCarriers.some((carrier) => carrier.split(/[?*[{]/u, 1)[0].replace(/\/$/u, "") === "");
    const carriers = [...new Set(positiveCarriers
      .map((carrier) => carrier.split(/[?*[{]/u, 1)[0].replace(/\/$/u, ""))
      .filter(Boolean))];
    // A root-level glob (for example zod's **/*.js) names runtime files at
    // the package root. Copying only its empty static prefix silently omits
    // those exports. copyTree still enforces the release-wide omissions.
    if (rootGlob) await copyTree(source, target);
    for (const carrier of carriers) {
      const sourcePath = resolve(source, carrier);
      if (!inside(source, sourcePath) || !(await exists(sourcePath))) continue;
      await copyTree(sourcePath, join(target, relative(source, sourcePath)));
    }
  } else {
    await copyTree(source, target);
  }
  await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (entry && !(await exists(join(target, "src"))) && !(await exists(join(target, "dist")))) {
    throw new Error(`entry package ${manifest.name} exposes no src or dist runtime carrier`);
  }
}

export async function artifactDigest(root, { includeSymbolicLinks = false } = {}) {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "release-receipt.json") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink() && includeSymbolicLinks) {
        const target = await readlink(path);
        if (!inside(resolve(root), resolve(dirname(path), target))) throw new Error(`runtime binding escapes its release: ${relative(root, path)}`);
        hash.update(relative(root, path)); hash.update("\0symlink\0"); hash.update(target); hash.update("\0");
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        const mode = (await stat(path)).mode & 0o777;
        fileCount += 1;
        byteCount += bytes.byteLength;
        hash.update(relative(root, path)); hash.update("\0"); hash.update(mode.toString(8)); hash.update("\0"); hash.update(bytes); hash.update("\0");
      }
    }
  }
  await visit(root);
  return { digest: hash.digest("hex"), fileCount, byteCount };
}

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || BUILTIN_MODULES.has(specifier)) return null;
  if (!/^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~!$&()+,;=:@%-]+)*$/u.test(specifier)) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const ACTIVE_EXPORT_CONDITIONS = new Set(["default", "import", "node", "node-addons"]);

function exportedSubpath(dependency, specifier) {
  return specifier === dependency ? "." : `./${specifier.slice(dependency.length + 1)}`;
}

function conditionalExportTarget(target, patternMatch = null) {
  if (typeof target === "string") return patternMatch === null ? target : target.replaceAll("*", patternMatch);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = conditionalExportTarget(candidate, patternMatch);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (target === null || typeof target !== "object") return null;
  for (const [condition, candidate] of Object.entries(target)) {
    if (!ACTIVE_EXPORT_CONDITIONS.has(condition)) continue;
    const resolved = conditionalExportTarget(candidate, patternMatch);
    if (resolved !== null) return resolved;
  }
  return null;
}

function packageExportTarget(manifest, subpath) {
  const exports = manifest.exports;
  if (exports === undefined) {
    const target = subpath === "." ? (manifest.main ?? "./index.js") : subpath;
    return target.startsWith("./") ? target : `./${target}`;
  }
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === "." ? conditionalExportTarget(exports) : null;
  if (exports === null || typeof exports !== "object") return null;
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith("."))) return subpath === "." ? conditionalExportTarget(exports) : null;
  if (Object.hasOwn(exports, subpath)) return conditionalExportTarget(exports[subpath]);
  const patterns = keys.filter((key) => key.includes("*") && key.startsWith("./"))
    .map((key) => {
      const [prefix, suffix] = key.split("*", 2);
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) return null;
      return { key, prefix, suffix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
    })
    .filter(Boolean)
    .sort((left, right) => right.prefix.length - left.prefix.length || right.suffix.length - left.suffix.length);
  return patterns.length === 0 ? null : conditionalExportTarget(exports[patterns[0].key], patterns[0].match);
}

async function runtimeExportExists(packageDirectory, manifest, subpath) {
  const target = packageExportTarget(manifest, subpath);
  if (typeof target !== "string" || !target.startsWith("./")) return { target, exists: false };
  const targetPath = resolve(packageDirectory, target);
  if (!inside(packageDirectory, targetPath)) return { target, exists: false };
  if (await isFile(targetPath)) return { target, exists: true };
  if (manifest.exports !== undefined) return { target, exists: false };
  for (const fallback of [`${targetPath}.js`, `${targetPath}.json`, `${targetPath}.node`, join(targetPath, "index.js"), join(targetPath, "index.json"), join(targetPath, "index.node")]) {
    if (await isFile(fallback)) return { target: `./${relative(packageDirectory, fallback)}`, exists: true };
  }
  return { target, exists: false };
}

async function assertConcreteRuntimeExports(packageDirectory, manifest) {
  const finding = (await concreteRuntimeExportFindings(packageDirectory, manifest))[0];
  if (finding) throw new Error(`immutable tarball provider ${manifest.name} export ${finding.subpath} -> ${finding.target ?? "<unexported>"} is absent`);
}

async function concreteRuntimeExportFindings(packageDirectory, manifest) {
  if (manifest.exports === undefined) return [];
  const exports = manifest.exports;
  const subpaths = (exports !== null && typeof exports === "object" && !Array.isArray(exports)
    && Object.keys(exports).some((key) => key.startsWith(".")))
    ? Object.keys(exports).filter((key) => key.startsWith(".") && !key.includes("*")).sort()
    : ["."];
  const findings = [];
  for (const subpath of subpaths) {
    const resolution = await runtimeExportExists(packageDirectory, manifest, subpath);
    if (!resolution.exists) findings.push({ subpath, target: resolution.target ?? null });
  }
  return findings;
}

async function unresolvedRuntimeImports(root, admittedAbsent = new Set()) {
  const observed = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:mjs|mts|js)$/u.test(entry.name) && !entry.name.endsWith(".d.mts")) {
        const literals = [];
        const source = (await readFile(path, "utf8"))
          .replace(/`(?:\\[\s\S]|[^\\`])*`/gu, "__SXC_TEMPLATE_LITERAL__")
          .replace(/(["'])(?:\\[\s\S]|(?!\1)[^\\\r\n])*\1/gu, (literal) => {
            const index = literals.push(literal.slice(1, -1).replace(/\\([\\"'])/gu, "$1")) - 1;
            return `${literal[0]}__SXC_STRING_${index}__${literal.at(-1)}`;
          })
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .replace(/(^|\n)\s*\/\/[^\n]*/gu, "$1");
        const patterns = [
          /(?:^|\n)\s*(?:import|export)\s+(?:[^"'\r\n]*?\s+from\s+)?["']([^"'\\\r\n]+)["']/gu,
          /\bimport\s*\(\s*["']([^"'\\\r\n]+)["']\s*\)/gu,
          /\brequire\s*\(\s*["']([^"'\\\r\n]+)["']\s*\)/gu,
        ];
        for (const pattern of patterns) {
          for (const match of source.matchAll(pattern)) {
            const literal = /^__SXC_STRING_(\d+)__$/u.exec(match[1]);
            const specifier = literal ? literals[Number(literal[1])] : match[1];
            const dependency = packageName(specifier);
            if (dependency) {
              const observation = observed.get(dependency) ?? { carriers: new Set(), specifiers: new Set() };
              observation.carriers.add(relative(root, path));
              observation.specifiers.add(specifier);
              observed.set(dependency, observation);
            }
          }
        }
      }
    }
  }
  await visit(join(root, "app"));
  const unresolved = [];
  for (const dependency of [...observed.keys()].sort()) {
    if (admittedAbsent.has(dependency)) continue;
    const observation = observed.get(dependency);
    const packageDirectory = join(root, "app", "node_modules", ...dependency.split("/"));
    const manifestPath = join(packageDirectory, "package.json");
    if (!(await exists(manifestPath))) {
      unresolved.push({ packageName: dependency, carriers: [...observation.carriers].sort(), specifiers: [...observation.specifiers].sort(), missingTargets: [] });
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const missingTargets = [];
    for (const specifier of [...observation.specifiers].sort()) {
      const subpath = exportedSubpath(dependency, specifier);
      const resolution = await runtimeExportExists(packageDirectory, manifest, subpath);
      if (!resolution.exists) missingTargets.push({ specifier, subpath, target: resolution.target });
    }
    if (missingTargets.length > 0) {
      unresolved.push({ packageName: dependency, carriers: [...observation.carriers].sort(), specifiers: [...observation.specifiers].sort(), missingTargets });
    }
  }
  return unresolved;
}

function unresolvedRuntimeImportDescription({ packageName: dependency, carriers, missingTargets }) {
  const targetDescription = missingTargets.length === 0
    ? "package manifest"
    : missingTargets.map(({ subpath, target }) => `export ${subpath} -> ${target ?? "<unexported>"}`).join("+");
  return `${dependency} ${targetDescription} imported by ${carriers.join("+")}`;
}

function staticModuleRequests(source, commonJs) {
  return readJsnodeRuntimeModuleRequests(source, commonJs ? "runtime.cjs" : "runtime.mjs");
}

async function isCommonJs(root, file) {
  if (file.endsWith(".cjs")) return true;
  if (!file.endsWith(".js")) return false;
  for (let directory = dirname(file); inside(root, directory); directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (await isFile(manifestPath)) return JSON.parse(await readFile(manifestPath, "utf8")).type !== "module";
    if (directory === dirname(directory)) break;
  }
  return true;
}

async function resolveRuntimeRequest(root, importer, specifier, commonJs) {
  try {
    const resolved = commonJs
      ? createRequire(importer).resolve(specifier)
      : resolveImport(specifier, pathToFileURL(importer).href);
    const path = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    return inside(root, path) && await isFile(path) ? path : null;
  } catch { return null; }
}

function validateRuntimePolicy(dependencyExportPolicy, runtimeEntrypoints) {
  if (!["strict", "runtime-imports"].includes(dependencyExportPolicy)) throw new TypeError("dependencyExportPolicy must be strict or runtime-imports");
  const validationRoot = resolve("runtime-entry-validation");
  if (!Array.isArray(runtimeEntrypoints) || runtimeEntrypoints.some((entry) =>
    typeof entry !== "string" || !entry || entry.startsWith("/") || !inside(validationRoot, resolve(validationRoot, entry)))) {
    throw new TypeError("runtimeEntrypoints must be relative entry paths within the release");
  }
  if (dependencyExportPolicy === "runtime-imports" && runtimeEntrypoints.length === 0) throw new TypeError("runtime-imports requires explicit runtimeEntrypoints");
}

async function reachableRuntimeImportViolations(root, entrypoints) {
  const pending = entrypoints.map((entry) => resolve(root, entry)), visited = new Set(), missing = [], analysisLimits = [], guardedUnavailable = [];
  for (const file of pending) {
    if (!inside(root, file) || !(await isFile(file)) || !/\.(?:mjs|mts|js|cjs)$/u.test(file)) {
      throw new TypeError("runtime entry root must name an existing JavaScript module within the release");
    }
  }
  while (pending.length > 0) {
    const file = pending.shift();
    if (visited.has(file) || !/\.(?:mjs|mts|js|cjs)$/u.test(file)) continue;
    visited.add(file);
    for (const request of staticModuleRequests(await readFile(file, "utf8"), await isCommonJs(root, file))) {
      const { kind, specifier } = request;
      if (specifier === null) { analysisLimits.push({ kind, carrier: relative(root, file) }); continue; }
      if (BUILTIN_MODULES.has(specifier)) continue;
      const resolved = await resolveRuntimeRequest(root, file, specifier, kind === "require");
      if (resolved !== null) { pending.push(resolved); continue; }
      const dependency = packageName(specifier) ?? specifier;
      if (request.guarded) guardedUnavailable.push({ dependency, carrier: relative(root, file) });
      else missing.push({ packageName: dependency, carriers: [relative(root, file)], missingTargets: [] });
    }
  }
  return { missing, analysisLimits, guardedUnavailable };
}

export async function verifyNodeRuntimeRelease(releaseDirectory) {
  const receipt = JSON.parse(await readFile(join(releaseDirectory, "release-receipt.json"), "utf8"));
  const traced = receipt.type === "TracedNodeRuntimeMaterialization";
  if (traced && (![1, 2].includes(receipt.version) || !/^[a-f0-9]{64}$/u.test(receipt.artifactDigest))) {
    throw new TypeError("invalid traced runtime release receipt");
  }
  const dependencyExportPolicy = traced ? "runtime-imports" : receipt.dependencyExportPolicy ?? "strict";
  const runtimeEntrypoints = traced ? receipt.entrypoints : receipt.runtimeEntrypoints ?? [];
  const runtimeRoot = traced ? resolve(releaseDirectory) : join(releaseDirectory, "app");
  const observed = await artifactDigest(releaseDirectory, { includeSymbolicLinks: traced && receipt.version === 2 });
  validateRuntimePolicy(dependencyExportPolicy, runtimeEntrypoints);
  const reachable = dependencyExportPolicy === "runtime-imports" ? await reachableRuntimeImportViolations(runtimeRoot, runtimeEntrypoints) : null;
  const unresolvedRuntimeImportsObserved = reachable?.missing ?? await unresolvedRuntimeImports(releaseDirectory, new Set(receipt.optionalRuntimePackagesAbsent ?? []));
  const unresolvedRuntimePackages = unresolvedRuntimeImportsObserved.map(({ packageName }) => packageName);
  const packageIdentities = new Map((receipt.packages ?? []).map((item) => [item.name, item]));
  const providerSelectionViolations = [];
  for (const selection of receipt.providerSelections ?? []) {
    const requiring = selection.requiringPackage === null ? null : packageIdentities.get(selection.requiringPackage);
    const selected = packageIdentities.get(selection.name);
    if (selection.requiringPackage !== null && requiring === undefined) providerSelectionViolations.push({ ...selection, reason: "requiring-package-absent" });
    else if (selected === undefined) providerSelectionViolations.push({ ...selection, reason: "selected-package-absent" });
    else if (selected.version !== selection.selectedVersion) providerSelectionViolations.push({ ...selection, reason: "selected-version-differs" });
    else if (selected.provider === "tarball" && selected.integrity !== selection.integrity) providerSelectionViolations.push({ ...selection, reason: "selected-integrity-differs" });
  }
  return {
    type: "NodeRuntimeReleaseVerificationObservation",
    ok: observed.digest === receipt.artifactDigest && unresolvedRuntimePackages.length === 0 && providerSelectionViolations.length === 0
      && (!traced || (reachable?.analysisLimits.length ?? 0) === 0),
    expectedDigest: receipt.artifactDigest,
    observedDigest: observed.digest,
    fileCount: observed.fileCount,
    byteCount: observed.byteCount,
    unresolvedRuntimePackages,
    unresolvedRuntimeCarriers: Object.fromEntries(unresolvedRuntimeImportsObserved.map(({ packageName, carriers }) => [packageName, carriers])),
    unresolvedRuntimeTargets: Object.fromEntries(unresolvedRuntimeImportsObserved.map(({ packageName, missingTargets }) => [packageName, missingTargets])),
    analysisLimits: reachable?.analysisLimits ?? [],
    guardedUnavailable: reachable?.guardedUnavailable ?? [],
    providerSelectionViolations,
  };
}

export async function materializeNodeRuntimeRelease({ entryPackageDirectory = null, entryPackageTarball = null, providerSources = {}, providerTarballs = {}, providerSelections = [], sourceCatalog = null, outputRoot }) {
  if ((entryPackageDirectory === null) === (entryPackageTarball === null)) throw new TypeError("exactly one entry package source or tarball admission is required");
  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true });
  const providerExtraction = await mkdtemp(join(output, ".admitting-tarballs-"));
  let entry;
  try {
    entry = entryPackageTarball === null
      ? await admittedSource(entryPackageDirectory)
      : await admitNpmTarballProvider(entryPackageTarball.name, entryPackageTarball, providerExtraction);
  } catch (error) {
    await rm(providerExtraction, { recursive: true, force: true });
    throw error;
  }
  const entryDirectory = entry.directory;
  const entryManifest = entry.manifest;
  if (!Array.isArray(providerSelections)) throw new TypeError("providerSelections must be an array");
  const normalizedProviderSelections = providerSelections.map((selection) => {
    if (selection === null || typeof selection !== "object" || typeof selection.name !== "string" || typeof selection.requested !== "string" || typeof selection.selectedVersion !== "string") {
      throw new TypeError("each provider selection must identify its dependency request and exact selected version");
    }
    if (!(selection.requiringPackage === null || typeof selection.requiringPackage === "string")) throw new TypeError("provider selection requiringPackage must be a package name or null");
    return structuredClone(selection);
  }).sort((left, right) => `${left.requiringPackage ?? ""}\0${left.name}\0${left.requested}\0${left.lockLocation ?? ""}`.localeCompare(`${right.requiringPackage ?? ""}\0${right.name}\0${right.requested}\0${right.lockLocation ?? ""}`));
  const selectionIndex = new Map(normalizedProviderSelections.filter(({ requiringPackage }) => requiringPackage !== null).map((selection) => [`${selection.requiringPackage}\0${selection.name}\0${selection.requested}`, selection]));
  const index = new Map([[entryManifest.name, entry]]);
  const admittedProviderSources = { ...providerSources };
  if (sourceCatalog !== null) {
    if (sourceCatalog?.type !== "NodePackageSourceCatalogReceipt" || sourceCatalog.version !== 1 || !Array.isArray(sourceCatalog.packages)) {
      throw new TypeError("sourceCatalog must be a NodePackageSourceCatalogReceipt v1");
    }
    if (sourceCatalog.entryPackage !== entryManifest.name) throw new Error(`source catalog entry ${sourceCatalog.entryPackage} does not match ${entryManifest.name}`);
    for (const item of sourceCatalog.packages) {
      if (item.name === entryManifest.name) continue;
      admittedProviderSources[item.name] = item.sourceDirectory;
    }
  }
  for (const [claimedName, source] of Object.entries(admittedProviderSources)) {
    const admitted = await admittedSource(source);
    if (admitted.manifest.name !== claimedName) throw new Error(`provider source claim ${claimedName} resolves to ${admitted.manifest.name}`);
    if (claimedName === entryManifest.name && admitted.directory === entryDirectory) continue;
    if (index.has(claimedName)) throw new Error(`duplicate provider source ${claimedName}`);
    index.set(claimedName, admitted);
  }

  try {
    for (const claimedName of Object.keys(providerTarballs).sort()) {
      if (index.has(claimedName)) throw new Error(`duplicate provider admission ${claimedName}`);
      index.set(claimedName, await admitNpmTarballProvider(claimedName, providerTarballs[claimedName], providerExtraction));
    }
  } catch (error) {
    await rm(providerExtraction, { recursive: true, force: true });
    throw error;
  }
  const temporary = await mkdtemp(join(output, ".materializing-"));
  const packages = [];
  const visited = new Set();
  const optionalRuntimePackagesAbsent = new Set();
  try {
    async function include(name, destination, entry = false) {
      if (visited.has(name)) return;
      const record = index.get(name);
      if (!record) throw new Error(`runtime dependency ${name} has no explicitly admitted provider source`);
      visited.add(name);
      const normalizedManifest = structuredClone(record.manifest);
      const optionalDependencyNames = new Set(Object.keys(normalizedManifest.optionalDependencies ?? {}));
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        if (!normalizedManifest[field]) continue;
        normalizedManifest[field] = Object.fromEntries(Object.keys(normalizedManifest[field]).sort().map((dependency) => {
          const provider = index.get(dependency);
          const optional = field === "optionalDependencies" || optionalDependencyNames.has(dependency)
            || (field === "peerDependencies" && normalizedManifest.peerDependenciesMeta?.[dependency]?.optional === true);
          if (!provider && optional) {
            optionalRuntimePackagesAbsent.add(dependency);
            return [dependency, normalizedManifest[field][dependency]];
          }
          if (!provider) throw new Error(`runtime dependency ${dependency} has no explicitly admitted provider source`);
          const requested = normalizedManifest[field][dependency];
          if (requested !== provider.manifest.version) {
            if (record.kind === "source" && sourceCatalog !== null) return [dependency, provider.manifest.version];
            const selection = selectionIndex.get(`${name}\0${dependency}\0${requested}`);
            if (selection?.selectedVersion !== provider.manifest.version) {
              throw new Error(`runtime provider ${name} requests ${dependency}@${requested}, not admitted ${provider.manifest.version} by lock selection evidence`);
            }
            if (provider.kind === "tarball" && selection.integrity !== provider.integrity) {
              throw new Error(`runtime provider ${name} lock selection for ${dependency}@${provider.manifest.version} has false integrity`);
            }
          }
          return [dependency, provider.manifest.version];
        }));
      }
      if (record.kind === "tarball") {
        await copyExactTree(record.directory, destination);
        await assertConcreteRuntimeExports(destination, normalizedManifest);
      } else await copyPackage(record.directory, destination, normalizedManifest, entry);
      packages.push({
        name,
        version: record.manifest.version,
        provider: record.kind,
        ...(record.kind === "tarball" ? { integrity: record.integrity } : {}),
      });
      for (const { name: dependency, requested, optional } of runtimeDependencies(normalizedManifest)) {
        if (optional && !index.has(dependency)) continue;
        if (!EXACT_VERSION.test(requested ?? "")) throw new Error(`runtime dependency ${dependency} must use one exact provider version, received ${requested}`);
        const provider = index.get(dependency);
        if (provider && provider.manifest.version !== requested) throw new Error(`runtime dependency ${dependency} requested ${requested} but admitted provider is ${provider.manifest.version}`);
        // The release carries one identity-selected provider per package.
        // Seat that singleton at the application root so every consumer can
        // resolve it; nesting the first traversal edge while de-duplicating by
        // identity leaves later sibling consumers with no reachable package.
        await include(dependency, join(temporary, "app", "node_modules", ...dependency.split("/")));
      }
    }
    await include(entryManifest.name, join(temporary, "app"), true);
    packages.sort((left, right) => left.name.localeCompare(right.name));
    const unresolved = await unresolvedRuntimeImports(temporary, optionalRuntimePackagesAbsent);
    if (unresolved.length > 0) {
      throw new Error(`runtime import closure is missing ${unresolved.map(unresolvedRuntimeImportDescription).join(", ")}`);
    }
    const artifact = await artifactDigest(temporary);
    const artifactDigestValue = artifact.digest;
    const releaseDirectory = join(output, artifactDigestValue);
    const receipt = {
      type: "NodeRuntimeReleaseMaterializationReceipt",
      version: 1,
      entryPackage: entryManifest.name,
      entryCarrier: (await exists(join(temporary, "app", "src", "server.mts"))) ? "app/src/server.mts" : null,
      artifactDigest: artifactDigestValue,
      fileCount: artifact.fileCount,
      byteCount: artifact.byteCount,
      nodeVersion: process.version,
      sourceCatalog: sourceCatalog?.id ?? null,
      optionalRuntimePackagesAbsent: [...optionalRuntimePackagesAbsent].sort(),
      providerSelections: normalizedProviderSelections,
      packages,
      releaseDirectory,
    };
    await writeFile(join(temporary, "release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (await exists(releaseDirectory)) await rm(temporary, { recursive: true });
    else await rename(temporary, releaseDirectory);
    await rm(providerExtraction, { recursive: true, force: true });
    return receipt;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(providerExtraction, { recursive: true, force: true });
    throw error;
  }
}

function catalogDigest(body) {
  return sha256Hex(JSON.stringify(body));
}

function resolveInstallGraphLocation(nodes, ownerLocation, name) {
  let location = ownerLocation;
  while (true) {
    const candidate = location === "" ? `node_modules/${name}` : `${location}/node_modules/${name}`;
    if (Object.hasOwn(nodes, candidate)) return candidate;
    if (location === "") return null;
    const marker = location.lastIndexOf("/node_modules/");
    location = marker === -1 ? "" : location.slice(0, marker);
  }
}

async function materializeNodeRuntimeInstallGraph({ id, nodes, outputRoot, dependencyExportPolicy, runtimeEntrypoints }) {
  if (!nodes?.[""]) throw new Error(`runtime entry ${id} install graph has no root node`);
  const output = resolve(outputRoot);
  await mkdir(output, { recursive: true });
  const extraction = await mkdtemp(join(output, ".admitting-install-graph-"));
  const temporary = await mkdtemp(join(output, ".materializing-install-graph-"));
  try {
    const admitted = new Map();
    for (const [location, claim] of Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b))) {
      if (claim.location !== location) throw new Error(`runtime install graph node key ${location} differs from its location claim`);
      const record = await admitNpmTarballProvider(claim.name, claim, join(extraction, sha256Hex(location)));
      if (record.manifest.version !== claim.version) throw new Error(`runtime install graph ${location} version differs from its tarball`);
      admitted.set(location, record);
    }
    for (const [location, claim] of Object.entries(nodes)) {
      const record = admitted.get(location);
      for (const { field, name, optional } of runtimeDependencies(record.manifest)) {
        const resolved = resolveInstallGraphLocation(nodes, location, name);
        if (resolved === null && optional) continue;
        if (resolved === null) throw new Error(`runtime install graph ${location || "<root>"} has no Node-resolvable edge for ${name}`);
        if (field === "peerDependencies" && location !== "" && resolved === `${location}/node_modules/${name}`) throw new Error(`runtime install graph ${location} places peer ${name} beneath its dependent`);
        if (claim.edges?.[name] !== resolved) throw new Error(`runtime install graph ${location || "<root>"} edge ${name} does not bind resolved location ${resolved}`);
      }
      for (const [name, target] of Object.entries(claim.edges ?? {})) {
        if (resolveInstallGraphLocation(nodes, location, name) !== target) throw new Error(`runtime install graph ${location || "<root>"} carries a false edge for ${name}`);
      }
    }
    const dependencyExportFindings = [];
    for (const [location, record] of admitted) {
      const destination = location === "" ? join(temporary, "app") : join(temporary, "app", location);
      await copyExactTree(record.directory, destination);
      const findings = await concreteRuntimeExportFindings(destination, record.manifest);
      if (findings.length > 0 && (location === "" || dependencyExportPolicy === "strict")) {
        const finding = findings[0];
        throw new Error(`immutable tarball provider ${record.manifest.name} export ${finding.subpath} -> ${finding.target ?? "<unexported>"} is absent`);
      }
      if (findings.length > 0) dependencyExportFindings.push(...findings.map((finding) => ({ location, package: record.manifest.name, version: record.manifest.version, ...finding })));
    }
    const reachable = dependencyExportPolicy === "runtime-imports" ? await reachableRuntimeImportViolations(join(temporary, "app"), runtimeEntrypoints) : null;
    const unresolved = reachable?.missing ?? await unresolvedRuntimeImports(temporary, new Set());
    if (unresolved.length) throw new Error(`runtime import closure is missing ${unresolved.map(unresolvedRuntimeImportDescription).join(", ")}`);
    const artifact = await artifactDigest(temporary), releaseDirectory = join(output, artifact.digest);
    const packages = Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b)).map(([location, claim]) => ({ location, name: claim.name, version: claim.version, provider: "tarball", integrity: claim.integrity }));
    const receipt = { type: "NodeRuntimeReleaseMaterializationReceipt", version: 1, entryPackage: nodes[""].name, entryCarrier: null, artifactDigest: artifact.digest, fileCount: artifact.fileCount, byteCount: artifact.byteCount, nodeVersion: process.version, sourceCatalog: null, optionalRuntimePackagesAbsent: [], providerSelections: [], dependencyExportPolicy, runtimeEntrypoints, dependencyExportFindings, analysisLimits: reachable?.analysisLimits ?? [], guardedUnavailable: reachable?.guardedUnavailable ?? [], installGraph: nodes, packages, releaseDirectory };
    await writeFile(join(temporary, "release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (await exists(releaseDirectory)) {
      const existing = JSON.parse(await readFile(join(releaseDirectory, "release-receipt.json"), "utf8"));
      if ((existing.dependencyExportPolicy ?? "strict") !== dependencyExportPolicy
        || JSON.stringify([...(existing.runtimeEntrypoints ?? [])].sort()) !== JSON.stringify([...runtimeEntrypoints].sort())) {
        throw new Error("existing artifact receipt has a different runtime verification policy; use a separate output root");
      }
      await rm(temporary, { recursive: true });
      return existing;
    }
    await rename(temporary, releaseDirectory);
    return receipt;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally { await rm(extraction, { recursive: true, force: true }); }
}

export async function materializeNodeRuntimeReleaseCatalog({ entries, providerSources = {}, providerTarballs = {}, providerSelections = [], outputRoot }) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("entries must be a non-empty array");
  const normalized = entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.id)) {
      throw new TypeError("each runtime entry requires a filesystem-safe id");
    }
    if (!((typeof entry.entryPackageDirectory === "string" && entry.entryPackageDirectory) || entry.entryPackageTarball !== undefined)) throw new TypeError(`runtime entry ${entry.id} requires an entry package source or tarball`);
    return entry;
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) throw new Error("runtime entry ids must be unique");
  const releasesRoot = join(resolve(outputRoot), "releases");
  const catalogEntries = [];
  for (const entry of normalized) {
    const receipt = await materializeNodeRuntimeRelease({
      entryPackageDirectory: entry.entryPackageDirectory,
      entryPackageTarball: entry.entryPackageTarball ?? null,
      providerSources: entry.providerSources ?? providerSources,
      providerTarballs: entry.providerTarballs ?? providerTarballs,
      providerSelections: entry.providerSelections ?? providerSelections,
      outputRoot: releasesRoot,
    });
    catalogEntries.push({
      id: entry.id,
      entryPackage: receipt.entryPackage,
      entryVersion: receipt.packages.find(({ name }) => name === receipt.entryPackage)?.version ?? null,
      entryCarrier: receipt.entryCarrier,
      artifactDigest: receipt.artifactDigest,
      releaseRelativePath: `../../releases/${receipt.artifactDigest}`,
    });
  }
  const body = { type: "NodeRuntimeReleaseCatalogReceipt", version: 1, entries: catalogEntries };
  const digest = catalogDigest(body);
  const catalogDirectory = join(resolve(outputRoot), "catalogs", digest);
  const persistedReceipt = { ...body, digest };
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(join(catalogDirectory, "runtime-release-catalog.json"), `${JSON.stringify(persistedReceipt, null, 2)}\n`);
  return { ...persistedReceipt, catalogDirectory };
}

/**
 * Materializes a Node runtime provider catalog into verified immutable releases.
 * @param {object} providerCatalog
 * @param {string} outputRoot
 * @param {{dependencyExportPolicy?: "strict"|"runtime-imports", runtimeEntrypoints?: string[]}} [options]
 * @returns {Promise<object>}
 */
export async function materializeNodeRuntimeProviderCatalog(providerCatalog, outputRoot, { dependencyExportPolicy = "strict", runtimeEntrypoints = [] } = {}) {
  if (providerCatalog?.type !== "NodeRuntimeProviderCatalog" || providerCatalog.version !== 1) {
    throw new TypeError("providerCatalog must be a NodeRuntimeProviderCatalog v1");
  }
  validateRuntimePolicy(dependencyExportPolicy, runtimeEntrypoints);
  const releasesRoot = join(resolve(outputRoot), "releases"), catalogEntries = [];
  for (const claim of [...providerCatalog.entries].sort((a, b) => a.id.localeCompare(b.id))) {
    const receipt = await materializeNodeRuntimeInstallGraph({ id: claim.id, nodes: providerCatalog.admissions?.[claim.id]?.nodes, outputRoot: releasesRoot, dependencyExportPolicy, runtimeEntrypoints });
    if (receipt.entryPackage !== claim.name || providerCatalog.admissions[claim.id].nodes[""].version !== claim.version) throw new Error(`provider catalog entry ${claim.id} root identity differs from its install graph`);
    catalogEntries.push({ id: claim.id, entryPackage: receipt.entryPackage, entryVersion: claim.version, entryCarrier: receipt.entryCarrier, artifactDigest: receipt.artifactDigest, releaseRelativePath: `../../releases/${receipt.artifactDigest}` });
  }
  const body = { type: "NodeRuntimeReleaseCatalogReceipt", version: 1, entries: catalogEntries }, digest = catalogDigest(body), catalogDirectory = join(resolve(outputRoot), "catalogs", digest), persistedReceipt = { ...body, digest };
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(join(catalogDirectory, "runtime-release-catalog.json"), `${JSON.stringify(persistedReceipt, null, 2)}\n`);
  return { ...persistedReceipt, catalogDirectory };
}

export async function verifyNodeRuntimeReleaseCatalog(catalogDirectory) {
  const receipt = JSON.parse(await readFile(join(catalogDirectory, "runtime-release-catalog.json"), "utf8"));
  if (receipt?.type !== "NodeRuntimeReleaseCatalogReceipt" || receipt.version !== 1 || !Array.isArray(receipt.entries)) {
    throw new Error("runtime release catalog is not a NodeRuntimeReleaseCatalogReceipt v1");
  }
  const observedDigest = catalogDigest({ type: receipt.type, version: receipt.version, entries: receipt.entries });
  const entries = [];
  for (const entry of receipt.entries) {
    const expectedRelativePath = `../../releases/${entry.artifactDigest}`;
    if (entry.releaseRelativePath !== expectedRelativePath) {
      entries.push({ id: entry.id, ok: false, reason: "release-relative-path-does-not-bind-artifact-digest" });
      continue;
    }
    entries.push({ id: entry.id, ...(await verifyNodeRuntimeRelease(resolve(catalogDirectory, entry.releaseRelativePath))) });
  }
  return {
    type: "NodeRuntimeReleaseCatalogVerificationObservation",
    ok: observedDigest === receipt.digest && entries.every(({ ok }) => ok),
    expectedDigest: receipt.digest,
    observedDigest,
    entries,
  };
}
