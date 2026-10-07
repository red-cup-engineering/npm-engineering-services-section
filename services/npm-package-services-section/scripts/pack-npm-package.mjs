#!/usr/bin/env node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { parseJavascriptArgv } from "@red-cup-engineering/javascript-node-services-section/argv";
import { readJavascriptFileExportDocumentation } from "@red-cup-engineering/read-javascript-file-export-documentation-service";

const executeNpm = promisify(execFile);

class NpmPackagePackingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new NpmPackagePackingError(code, message);
}

function exactRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) fail("INVALID_REQUEST", "input must be an NpmPackagePackingRequest");
  if (Object.keys(request).sort().join(",") !== "carrierDirectory,destinationDirectory,type,version") fail("UNEXPECTED_FIELDS", "request must carry exactly carrierDirectory, destinationDirectory, type, and version");
  if (request.type !== "NpmPackagePackingRequest" || request.version !== 1) fail("INVALID_REQUEST", "request type and version must be NpmPackagePackingRequest@1");
  return request;
}

async function existingDirectory(candidate, field) {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || resolve(candidate) !== candidate) fail("INVALID_DIRECTORY", `${field} must be an absolute normalized path`);
  let status;
  try { status = await lstat(candidate); }
  catch (error) { if (error?.code === "ENOENT") fail("INVALID_DIRECTORY", `${field} must name an existing directory`); throw error; }
  if (!status.isDirectory() || status.isSymbolicLink()) fail("INVALID_DIRECTORY", `${field} must name a non-symlink directory`);
  return candidate;
}

function within(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function reportedTarball(stdout) {
  let report;
  try { report = JSON.parse(stdout); } catch { fail("INVALID_NPM_REPORT", "npm pack did not emit JSON"); }
  if (!Array.isArray(report) || report.length !== 1 || report[0] === null || typeof report[0] !== "object") fail("INVALID_NPM_REPORT", "npm pack must report exactly one tarball");
  const filename = report[0].filename;
  if (typeof filename !== "string" || filename !== basename(filename) || !filename.endsWith(".tgz")) fail("INVALID_NPM_REPORT", "npm pack reported an invalid tarball filename");
  return filename;
}

/**
 * Packs one already-authored npm package directory into one explicit artifact directory.
 *
 * @param {object} request An NpmPackagePackingRequest@1 carrying absolute carrier and destination directory paths.
 * @param {object} capabilities Optional assay capabilities; production callers omit this argument.
 * @returns {Promise<object>} An immutable NpmPackagePackingReceipt@1 naming npm's verified tarball.
 * @throws {Error} When the request, npm execution, report, or artifact is invalid.
 */
export async function packNpmPackage(request, capabilities = {}) {
  exactRequest(request);
  const carrierDirectory = await existingDirectory(request.carrierDirectory, "carrierDirectory");
  const destinationDirectory = await existingDirectory(request.destinationDirectory, "destinationDirectory");
  const execute = capabilities.execute ?? executeNpm;
  if (typeof execute !== "function") fail("INVALID_CAPABILITY", "execute capability must be a function");
  const cacheDirectory = await mkdtemp(join(tmpdir(), "npm-package-packing-cache-"));
  try {
    let execution;
    try {
      execution = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destinationDirectory], {
        cwd: carrierDirectory,
        env: { ...process.env, npm_config_cache: cacheDirectory, npm_config_update_notifier: "false", npm_config_loglevel: "error", npm_config_workspaces: "false" },
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      fail("NPM_EXECUTION_FAILED", `npm pack failed: ${error?.stderr || error?.message || error}`);
    }
    const filename = reportedTarball(execution?.stdout);
    const artifactPath = resolve(destinationDirectory, filename);
    if (!within(destinationDirectory, artifactPath)) fail("INVALID_NPM_REPORT", "npm pack reported a tarball outside the destination");
    let status;
    try { status = await lstat(artifactPath); }
    catch (error) { if (error?.code === "ENOENT") fail("MISSING_ARTIFACT", "npm pack did not create its reported tarball"); throw error; }
    if (!status.isFile() || status.isSymbolicLink()) fail("INVALID_ARTIFACT", "reported tarball must be a regular non-symlink file");
    return freezeJson({ type: "NpmPackagePackingReceipt", version: 1, carrierDirectory, destinationDirectory, artifactPath, filename });
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const parsed = parseJavascriptArgv({ type: "JavascriptArgvParsingRequest", version: 1, argumentVector: { type: "JavascriptArgumentVector", version: 1, arguments: process.argv }, options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.options.help) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/pack-npm-package.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const receipts = [];
    for (const request of parseLines(text)) receipts.push(await packNpmPackage(request));
    const output = serializeLines(receipts);
    if (!process.stdout.write(output)) await once(process.stdout, "drain");
  }
}
