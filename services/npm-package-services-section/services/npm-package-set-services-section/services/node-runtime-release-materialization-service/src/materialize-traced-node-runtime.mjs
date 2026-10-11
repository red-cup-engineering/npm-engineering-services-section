import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolve as resolveImport } from "import-meta-resolve";
import { readJsnodeRuntimeModuleRequests } from "@red-cup-engineering/javascript-node-services-section/syntax";
import { artifactDigest } from "./materialize-release.mjs";

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, "node:" + name]));

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(".." + sep) && path !== "..");
}

function relativeCarrier(base, carrier) {
  if (typeof carrier !== "string" || !carrier || carrier.startsWith("/") || carrier.split(/[\\/]/u).includes("..")) throw new TypeError("traced runtime carrier escapes its base");
  const path = resolve(base, carrier);
  if (!inside(base, path)) throw new TypeError("traced runtime carrier escapes its base");
  return path;
}

async function metadata(path) {
  try { return await stat(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null; throw error; }
}

function packageName(request) {
  if (/^(?:[./#]|[a-zA-Z][a-zA-Z\d+.-]*:)/u.test(request)) return null;
  return request.split("/").slice(0, request.startsWith("@") ? 2 : 1).join("/");
}

// Files and the bindings Node follows are distinct carriers. Preserve both,
// including different provider versions seated at different consumer roots.
async function traceJsnodeRuntime(base, entrypoints, assets) {
  const files = new Set(), pending = [], modules = new Set(), bindings = new Map(), manifests = new Map();
  const obstructions = [], warnings = [];
  async function canonical(path) {
    const source = await realpath(path);
    if (!inside(base, source)) throw new Error("traced runtime carrier escapes its base: " + relative(base, path));
    return source;
  }
  async function scopes(file) {
    let nearest = null;
    for (let directory = dirname(file); inside(base, directory); directory = dirname(directory)) {
      const path = join(directory, "package.json");
      if ((await metadata(path))?.isFile()) {
        if (!manifests.has(path)) manifests.set(path, JSON.parse(await readFile(path, "utf8")));
        files.add(path);
        nearest ??= manifests.get(path);
      }
      if (directory === base) break;
    }
    return nearest;
  }
  async function include(path, module = true) {
    const source = await canonical(path);
    if (!(await metadata(source))?.isFile()) throw new Error("traced runtime carrier is not a regular file: " + relative(base, path));
    if (!files.has(source)) {
      files.add(source);
      await scopes(source);
    }
    if (module && /\.(?:[cm]?js|mts)$/u.test(source) && !modules.has(source)) { modules.add(source); pending.push(source); }
    return source;
  }
  async function binding(importer, request) {
    const name = packageName(request);
    if (name === null || (await scopes(importer))?.name === name) return;
    for (let directory = dirname(importer); inside(base, directory); directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", ...name.split("/"));
      if ((await metadata(candidate))?.isDirectory()) {
        const target = await canonical(candidate);
        if ((await metadata(join(target, "package.json")))?.isFile()) await include(join(target, "package.json"), false);
        if (candidate !== target) {
          const prior = bindings.get(candidate);
          if (prior !== undefined && prior !== target) throw new Error("conflicting runtime binding: " + candidate);
          bindings.set(candidate, target);
        }
        return;
      }
      if (directory === base) break;
    }
  }
  const visitedAssets = new Set();
  async function asset(path) {
    const source = await canonical(path);
    if (path !== source) bindings.set(path, source);
    if (visitedAssets.has(source)) return;
    visitedAssets.add(source);
    if ((await metadata(source)).isDirectory()) {
      for (const entry of (await readdir(source)).sort()) await asset(join(source, entry));
    } else await include(source, false);
  }
  for (const entrypoint of entrypoints) {
    const path = relativeCarrier(base, entrypoint), source = await include(path);
    if (source !== path) bindings.set(path, source);
  }
  for (const carrier of assets) await asset(relativeCarrier(base, carrier));
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const importer = pending[cursor], carrier = relative(base, importer);
    let requests;
    try { requests = readJsnodeRuntimeModuleRequests(await readFile(importer, "utf8"), importer); }
    catch (error) {
      obstructions.push({ code: "JSNODE_PARSE", carrier, message: String(error?.message ?? error) });
      continue;
    }
    for (const request of requests) {
      if (request.specifier === null) {
        obstructions.push({ code: "JSNODE_COMPUTED_REQUEST", carrier, kind: request.kind });
        continue;
      }
      if (BUILTINS.has(request.specifier)) continue;
      let target;
      try {
        const address = request.kind === "require"
          ? createRequire(importer).resolve(request.specifier)
          : resolveImport(request.specifier, pathToFileURL(importer).href);
        target = address.startsWith("file:") ? fileURLToPath(address) : address;
        if (!(await metadata(target))?.isFile()) throw new Error("target is not a regular file");
      } catch (error) {
        const observation = { code: request.guarded ? "JSNODE_GUARDED_UNAVAILABLE" : "JSNODE_UNRESOLVED_REQUEST", carrier, kind: request.kind, specifier: request.specifier, message: String(error?.message ?? error) };
        (request.guarded ? warnings : obstructions).push(observation);
        continue;
      }
      await binding(importer, request.specifier);
      const source = await include(target);
      if (target !== source) bindings.set(target, source);
    }
  }
  return { files, bindings, obstructions, warnings };
}

/**
 * Materialize selected executable modules, observed Node bindings and explicit
 * filesystem assets. Refuse unresolved mandatory edges and computed loaders.
 * Assets are declarations, not a claim that arbitrary filesystem reads were
 * inferred. The receiving consumer must demonstrate its operating effect.
 */
export async function materializeTracedNodeRuntime({ base, output, entrypoints, assets = [] }) {
  if (typeof base !== "string" || typeof output !== "string" || !Array.isArray(entrypoints) || !entrypoints.length || !Array.isArray(assets)) throw new TypeError("traced runtime requires base, output, nonempty entrypoints and an assets array");
  const canonicalBase = await realpath(base);
  const destination = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
  if (inside(canonicalBase, destination) || inside(destination, canonicalBase)) throw new Error("traced runtime base and output overlap");
  if (await metadata(destination)) throw new Error("traced runtime output already exists");
  for (const carrier of [...entrypoints, ...assets]) relativeCarrier(canonicalBase, carrier);
  if (new Set(entrypoints).size !== entrypoints.length) throw new TypeError("traced runtime entrypoints must be unique");
  const trace = await traceJsnodeRuntime(canonicalBase, entrypoints, assets);
  if (trace.obstructions.length) {
    const error = new Error("JSNode runtime closure refused: " + trace.obstructions.length + " unresolved mandatory or computed module requests");
    error.code = "JSNODE_RUNTIME_CLOSURE_REFUSED";
    error.obstructions = trace.obstructions;
    throw error;
  }
  const files = [...trace.files].map((path) => relative(canonicalBase, path)).sort();
  const bindings = [...trace.bindings].map(([path, target]) => ({ carrier: relative(canonicalBase, path), target: relative(canonicalBase, target) })).sort((a, b) => a.carrier.localeCompare(b.carrier));
  const stage = await mkdtemp(destination + ".stage-");
  try {
    for (const carrier of files) {
      const source = join(canonicalBase, carrier), target = join(stage, carrier), mode = (await stat(source)).mode & 0o777;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source), { mode, flag: "wx" });
      await chmod(target, mode);
    }
    for (const { carrier, target } of bindings) {
      const link = join(stage, carrier);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), join(stage, target)), link);
    }
    const artifact = await artifactDigest(stage, { includeSymbolicLinks: true });
    const receipt = { type: "TracedNodeRuntimeMaterialization", version: 2, base: canonicalBase, output: destination, entrypoints, assets, files, bindings, warnings: trace.warnings, fileCount: artifact.fileCount, byteCount: artifact.byteCount, artifactDigest: artifact.digest };
    await writeFile(join(stage, "release-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    await rename(stage, destination);
    return receipt;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
