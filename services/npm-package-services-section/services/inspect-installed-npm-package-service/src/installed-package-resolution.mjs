import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freezeJson } from "@red-cup-engineering/json-services-section";

const execute = promisify(execFile);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** @param {string} command @param {string[]} args @param {object} options @param {Function} [executor] @returns {Promise<object>} @throws {Error} When execution fails, including a returned spawn error. */
export async function executeInspectionCommand(command, args, options, executor = execute) {
  const result = await executor(command, args, { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")), ...options });
  if (result.error) throw Object.assign(new Error(result.error.message ?? String(result.error)), { code: result.error.code, spawnError: result.error.message ?? String(result.error) });
  if (result.signal || (result.status !== undefined && result.status !== 0)) throw Object.assign(new Error("inspection subprocess failed"), result);
  return result;
}

/** @param {object} request @returns {void} @throws {TypeError} When identity or paths are not explicit. */
export function assertInspectionRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new TypeError("input must be an InstalledNpmPackageInspectionRequest");
  if (Object.keys(request).filter(key => key !== "entry").sort().join(",") !== "expectedName,expectedVersion,packageRoot,projectRoot,type,version") throw new TypeError("request must carry exactly expectedName, expectedVersion, packageRoot, projectRoot, type, and version, with optional entry");
  if (request.type !== "InstalledNpmPackageInspectionRequest" || request.version !== 1) throw new TypeError("request type and version must be InstalledNpmPackageInspectionRequest@1");
  if (typeof request.expectedName !== "string" || !request.expectedName.length) throw new TypeError("expectedName must be a nonempty string");
  if (!EXACT_VERSION.test(request.expectedVersion ?? "")) throw new TypeError("expectedVersion must be an exact version");
  for (const field of ["packageRoot", "projectRoot"]) {
    if (request[field] !== null && (typeof request[field] !== "string" || !isAbsolute(request[field]) || resolve(request[field]) !== request[field])) throw new TypeError(field + " must be null or an absolute normalized path");
  }
  if (request.packageRoot === null && request.projectRoot === null) throw new TypeError("packageRoot and projectRoot cannot both be null");
  if (request.entry !== undefined) {
    const entry = request.entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("entry must select a package, import, or bin");
    if (entry.kind === "import" && request.projectRoot === null) throw new TypeError("explicit import entry requires a consumer projectRoot");
    const keys = Object.keys(entry).sort().join(",");
    if (entry.kind === "package" && keys === "kind") return;
    if (entry.kind === "bin" && keys === "kind,name" && typeof entry.name === "string" && /^[^/\\]+$/u.test(entry.name) && ![".", "..", ""].includes(entry.name)) return;
    if (entry.kind === "import" && ["kind,specifier", "attributes,kind,specifier"].includes(keys) && typeof entry.specifier === "string" && (entry.specifier === request.expectedName || entry.specifier.startsWith(request.expectedName + "/"))) {
      if (entry.attributes === undefined || (entry.attributes && Object.keys(entry.attributes).join(",") === "type" && entry.attributes.type === "json")) return;
    }
    throw new TypeError("entry must select package identity, a package import with optional JSON attributes, or a named bin");
  }
}

async function installedRoot(request) {
  if (request.projectRoot === null) return realpath(request.packageRoot);
  for (const directory of createRequire(join(request.projectRoot, "__package_inspection__.cjs")).resolve.paths(request.expectedName) ?? []) {
    const candidate = join(directory, request.expectedName);
    try { await readFile(join(candidate, "package.json")); return await realpath(candidate); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw Object.assign(new Error("package is absent from the consumer's Node lookup paths"), { code: "MODULE_NOT_FOUND" });
}

/**
 * Resolves the package through Node from the consumer and reads its actual manifest even when exports hides package.json.
 * @param {object} request An InstalledNpmPackageInspectionRequest@1; expectedVersion is the declared exact pin and packageRoot may be null.
 * @param {object} [capabilities] Optional executor for tests.
 * @returns {Promise<object>} Actual entry, package path, name, version, expected identity, and structured defects; no registry metadata or module execution.
 * @throws {TypeError} When the request lacks an exact expected identity.
 */
export async function inspectInstalledNpmPackageResolution(request, capabilities = {}) {
  assertInspectionRequest(request);
  const defects = [];
  let packageRoot = request.packageRoot;
  let entryPath = null;
  let manifest = null;
  const entry = request.entry ?? { kind: "import", specifier: request.expectedName };
  try {
    if (request.projectRoot !== null && entry.kind === "import") {
      const { stdout } = await executeInspectionCommand(process.execPath, ["--input-type=module", "--eval", "process.stdout.write(import.meta.resolve(process.argv[1]))", entry.specifier], { cwd: request.projectRoot, timeout: 10_000, maxBuffer: 1024 * 1024 }, capabilities.execute);
      entryPath = fileURLToPath(stdout.trim());
      await readFile(entryPath);
      let directory = dirname(entryPath);
      while (true) {
        try {
          const candidate = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
          if (typeof candidate.name === "string") { manifest = candidate; packageRoot = directory; break; }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        const parent = dirname(directory);
        if (parent === directory) throw new Error("resolved entry has no matching package manifest");
        directory = parent;
      }
    } else {
      packageRoot = await installedRoot(request);
      manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      if (entry.kind === "bin") {
        if (request.projectRoot === null) throw new TypeError("bin resolution requires a consumer projectRoot");
        const bins = typeof manifest.bin === "string" ? { [manifest.name.split("/").at(-1)]: manifest.bin } : manifest.bin ?? {};
        const target = bins[entry.name];
        if (typeof target !== "string") throw new Error("requested bin is not declared by the installed package");
        entryPath = await realpath(join(request.projectRoot, "node_modules", ".bin", entry.name));
        const expectedTarget = await realpath(resolve(packageRoot, target));
        if (entryPath !== expectedTarget || !(entryPath.startsWith(packageRoot + "/"))) throw new Error("installed bin link differs from its declared package target");
        await access(entryPath, constants.X_OK);
      }
    }
    if (manifest.name !== request.expectedName || manifest.version !== request.expectedVersion) defects.push({ law: "installed-identity", expectedName: request.expectedName, expectedVersion: request.expectedVersion, actualName: manifest.name ?? null, actualVersion: manifest.version ?? null, packageRoot, entryPath });
    if (request.projectRoot !== null && request.packageRoot !== null && packageRoot !== await realpath(request.packageRoot)) defects.push({ law: "installed-resolution-path", expectedPackageRoot: request.packageRoot, actualPackageRoot: packageRoot, entryPath });
  } catch (error) {
    defects.push({ law: request.projectRoot === null ? "installed-package-missing" : "installed-package-resolution", expectedName: request.expectedName, expectedVersion: request.expectedVersion, diagnostic: error.message, code: error.code ?? null, spawnError: error.spawnError ?? null });
  }
  return freezeJson({ type: "InstalledNpmPackageResolutionRead", version: 1, expectedName: request.expectedName, expectedVersion: request.expectedVersion, projectRoot: request.projectRoot, entry, entryPath, packageRoot, name: manifest?.name ?? null, packageVersion: manifest?.version ?? null, conformant: defects.length === 0, defects });
}
