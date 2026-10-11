#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { parseJavascriptArgv } from "@red-cup-engineering/javascript-node-services-section/argv";
import { readJavascriptFileExportDocumentation } from "@red-cup-engineering/read-javascript-file-export-documentation-service";
import { readJavascriptFileImports } from "@red-cup-engineering/javascript-file-import-services-section/read-javascript-file-imports";

import { assertInspectionRequest, executeInspectionCommand, inspectInstalledNpmPackageResolution } from "../src/installed-package-resolution.mjs";
export { inspectInstalledNpmPackageResolution } from "../src/installed-package-resolution.mjs";

const execute = executeInspectionCommand;
const JAVASCRIPT = /\.(?:cjs|js|mjs)$/u;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:workspace:|file:|link:)/iu;

async function exists(candidate) {
  try { await access(candidate); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function targets(value, output = new Set()) {
  if (typeof value === "string") output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => targets(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => targets(item, output));
  return output;
}

function faceTargets(manifest) {
  return [...targets(manifest.types, targets(manifest.module, targets(manifest.main, targets(manifest.bin, targets(manifest.exports)))))] .sort();
}

async function importSpecifiers(manifest, root) {
  if (manifest.exports === undefined) return manifest.main || await exists(join(root, "index.js")) ? [manifest.name] : [];
  if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return [manifest.name];
  const keys = Object.keys(manifest.exports);
  if (!keys.every((key) => key.startsWith("."))) return [manifest.name];
  return keys.filter((key) => !key.includes("*")).map((key) => key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`).sort();
}

function binTargets(manifest) {
  if (typeof manifest.bin === "string") return [{ name: manifest.name.split("/").at(-1), target: manifest.bin }];
  if (!manifest.bin || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) return [];
  return Object.entries(manifest.bin).filter(([, target]) => typeof target === "string").map(([name, target]) => ({ name, target })).sort((left, right) => left.name.localeCompare(right.name));
}

function dependencyName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/", 1)[0];
}

async function javascriptFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && JAVASCRIPT.test(entry.name)) files.push(candidate);
    }
  }
  await visit(root);
  return files.sort();
}

async function resolveEsmBareSpecifier(specifier, directory) {
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", "process.stdout.write(import.meta.resolve(process.argv[1]))", specifier], { cwd: directory, timeout: 10_000, maxBuffer: 1024 * 1024 });
  return fileURLToPath(stdout);
}

// Bare-specifier resolution must go through real ESM resolution (import.meta.resolve, in a
// subprocess so it can be pointed at an arbitrary directory), not require.resolve(): a
// require()-style resolve only honors "require"/"default" export conditions, so it falsely
// refuses any ESM-only dependency whose exports map carries only an "import" condition.
// import.meta.resolve only resolves the specifier; it never executes the target module.
async function resolveImport(record) {
  const parent = pathToFileURL(record.path).href;
  if (record.kind === "require") return createRequire(parent).resolve(record.specifier);
  if (record.specifier.startsWith(".") || record.specifier.startsWith("/")) return fileURLToPath(new URL(record.specifier, parent));
  if (BUILTINS.has(record.specifier)) return createRequire(parent).resolve(record.specifier);
  return resolveEsmBareSpecifier(record.specifier, dirname(record.path));
}

/**
 * Inspects one installed npm package without installing, repairing, or rewriting it.
 *
 * @param {object} request An InstalledNpmPackageInspectionRequest@1 naming the installed package and expected identity.
 * @returns {Promise<object>} An immutable InstalledNpmPackageInspectionRead@1 with explicit defects.
 * @throws {Error} When the request or installed package cannot be read.
 */
export async function inspectInstalledNpmPackage(request) {
  assertInspectionRequest(request);
  let resolution = await inspectInstalledNpmPackageResolution({ ...request, entry: request.entry ?? { kind: "package" } });
  if (request.entry === undefined && request.projectRoot !== null && resolution.name !== null) {
    const installed = JSON.parse(await readFile(join(resolution.packageRoot, "package.json"), "utf8"));
    if ((await importSpecifiers(installed, resolution.packageRoot)).includes(request.expectedName)) resolution = await inspectInstalledNpmPackageResolution(request);
  }
  const root = resolution.packageRoot;
  const defects = [...resolution.defects];
  if (resolution.name === null || (!resolution.conformant && request.projectRoot !== null)) return freezeJson({ type: "InstalledNpmPackageInspectionRead", version: 1, name: resolution.name, packageVersion: resolution.packageVersion, packageRoot: root, javascriptFileCount: 0, reachableJavascriptFileCount: 0, resolution, conformant: false, defects });
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    for (const [dependency, specification] of Object.entries(manifest[field] ?? {})) if (typeof specification === "string" && LOCAL_DEPENDENCY_PROTOCOL.test(specification)) defects.push({ law: "installed-local-dependency-protocol", field, dependency, specification });
  }
  for (const target of faceTargets(manifest)) {
    if (target.includes("*")) continue;
    const candidate = resolve(root, target);
    if (!inside(root, candidate) || !(await exists(candidate))) defects.push({ law: "installed-face-target", target });
  }

  if (request.projectRoot !== null) {
    const specifiers = await importSpecifiers(manifest, root);
    if (request.entry?.kind === "import" && !specifiers.includes(request.entry.specifier)) specifiers.push(request.entry.specifier);
    for (const specifier of specifiers) {
      try {
        const resolved = await resolveEsmBareSpecifier(specifier, request.projectRoot);
        const attributes = request.entry?.kind === "import" && request.entry.specifier === specifier && request.entry.attributes !== undefined ? request.entry.attributes : resolved.endsWith(".json") ? { type: "json" } : undefined;
        await execute(process.execPath, ["--input-type=module", "--eval", "const attributes = JSON.parse(process.argv[2]); await import(process.argv[1], attributes === null ? undefined : { with: attributes })", specifier, JSON.stringify(attributes ?? null)], { cwd: request.projectRoot, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      }
      catch (error) { defects.push({ law: "declared-import-runtime", specifier, diagnostic: error.stderr || error.stdout || error.message }); }
    }
    for (const { name, target } of binTargets(manifest)) {
      const bin = await inspectInstalledNpmPackageResolution({ ...request, entry: { kind: "bin", name } });
      if (!bin.conformant) defects.push({ law: "installed-bin-link", name, target, defects: bin.defects });
    }
  }

  const files = await javascriptFiles(root);
  const syntacticallyInvalid = new Set();
  for (const file of files) {
    try { await execute(process.execPath, ["--check", file], { maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { syntacticallyInvalid.add(file); defects.push({ law: "shipped-javascript-syntax", file: relative(root, file), diagnostic: error.stderr || error.message }); }
  }

  const declaredDependencies = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }));
  const reachable = [];
  const queued = new Set();
  for (const target of faceTargets(manifest)) {
    if (target.includes("*")) continue;
    const candidate = resolve(root, target);
    if (inside(root, candidate) && JAVASCRIPT.test(candidate) && await exists(candidate) && !queued.has(candidate)) { queued.add(candidate); reachable.push(candidate); }
  }
  for (let index = 0; index < reachable.length; index += 1) {
    const file = reachable[index];
    if (syntacticallyInvalid.has(file)) continue;
    const source = await readFile(file, "utf8");
    for (const imported of readJavascriptFileImports({ type: "TextFileRead", path: file, text: source }).imports) {
      const specifier = imported.specifier;
      if (!specifier.startsWith(".") && !specifier.startsWith("/") && !BUILTINS.has(specifier) && !specifier.startsWith("#")) {
        const dependency = dependencyName(specifier);
        if (dependency !== manifest.name && !declaredDependencies.has(dependency)) defects.push({ law: "runtime-dependency-declaration", file: relative(root, file), specifier, dependency });
      }
      let target;
      try { target = await resolveImport(imported); }
      catch (error) { defects.push({ law: "runtime-import-resolution", file: relative(root, file), specifier, diagnostic: error.message }); continue; }
      const relativeSpecifier = specifier.startsWith(".") || specifier.startsWith("/");
      if (relativeSpecifier && (typeof target !== "string" || !isAbsolute(target) || !inside(root, target))) defects.push({ law: "relative-import-membrane", file: relative(root, file), specifier });
      else if (relativeSpecifier && !(await exists(target))) defects.push({ law: "runtime-import-resolution", file: relative(root, file), specifier, diagnostic: "resolved file is absent" });
      else if (typeof target === "string" && isAbsolute(target) && inside(root, target) && JAVASCRIPT.test(target) && !queued.has(target)) { queued.add(target); reachable.push(target); }
    }
  }

  return freezeJson({ type: "InstalledNpmPackageInspectionRead", version: 1, name: manifest.name, packageVersion: manifest.version, packageRoot: root, javascriptFileCount: files.length, reachableJavascriptFileCount: reachable.length, resolution, conformant: defects.length === 0, defects });
}

if (import.meta.main) {
  const parsed = parseJavascriptArgv({ type: "JavascriptArgvParsingRequest", version: 1, argumentVector: { type: "JavascriptArgumentVector", version: 1, arguments: process.argv }, options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.options.help) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/inspect-installed-npm-package.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const reads = [];
    for (const request of parseLines(text)) reads.push(await inspectInstalledNpmPackage(request));
    if (reads.some((read) => !read.conformant)) process.exitCode = 1;
    const output = serializeLines(reads);
    if (!process.stdout.write(output)) await once(process.stdout, "drain");
  }
}
