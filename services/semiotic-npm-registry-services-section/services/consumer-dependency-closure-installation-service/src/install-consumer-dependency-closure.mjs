// install-consumer-dependency-closure — wire one consumer service to the Union
// private package registry and install its complete dependency closure.
//
// Executable source composed from three crystallized prior implementations:
//   (a) npm-registry-service/src/package-registry.mjs (npm-registry-services-section) —
//       the client.npmrc materialization (public default registry plus one
//       scoped registry line per Union scope), which this kernel reads back
//       from the live registry rather than re-deriving;
//   (b) the settled consumer .npmrc pattern (gemini-inference-team,
//       recursive-infomaterial-fabrication-service): public registry default
//       plus Union scopes routed to the private registry;
//   (c) check-npm-registry-package-installations-service (npm-registry-services-section) — the declared-import
//       resolution law (import.meta.resolve exercised from the consumer's own
//       membrane in a child Node process).
//
// Closure-kind: process. Every path terminates in one typed receipt or one
// typed refusal. No prose partiality.

import { execFile } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SCOPE_LINE = /^@([a-z0-9-]+):registry=(\S+)$/u;

export class ClosureRefusal extends Error {
  constructor(refusal) {
    super(`${refusal.type}: ${refusal.law}`);
    this.refusal = Object.freeze({ type: "ConsumerDependencyClosureRefusal", version: 1, ...refusal });
  }
}

function refuse(law, detail) {
  throw new ClosureRefusal({ law, ...detail });
}

async function readConsumerManifest(consumer) {
  try {
    return JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  } catch (error) {
    refuse("consumer-manifest", { consumer, diagnostic: error.message });
  }
}

// The Union scope roster is the registry's own materialized client.npmrc —
// crystallized output of buildPackageRegistry, never a local guess.
async function unionScopeRoster({ registryUrl, fetchImplementation }) {
  let body;
  try {
    const response = await fetchImplementation(new URL("client.npmrc", registryUrl));
    if (!response.ok) refuse("registry-unreachable", { registry: registryUrl, diagnostic: `client.npmrc HTTP ${response.status}` });
    body = await response.text();
  } catch (error) {
    if (error instanceof ClosureRefusal) throw error;
    refuse("registry-unreachable", { registry: registryUrl, diagnostic: error.message });
  }
  const scopes = [];
  for (const line of body.split("\n")) {
    const match = SCOPE_LINE.exec(line.trim());
    if (match) scopes.push(match[1]);
  }
  if (scopes.length === 0) refuse("registry-unreachable", { registry: registryUrl, diagnostic: "registry client.npmrc names no Union scopes" });
  return scopes.sort();
}

function declaredDependencies(manifest) {
  const rows = [];
  for (const [kind, table] of [
    ["dependency", manifest.dependencies],
    ["devDependency", manifest.devDependencies],
    ["optionalDependency", manifest.optionalDependencies],
    ["peerDependency", manifest.peerDependencies],
  ]) {
    for (const [name, spec] of Object.entries(table ?? {})) rows.push({ name, kind, spec });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

function scopeOf(name) {
  return name.startsWith("@") ? name.slice(1, name.indexOf("/")) : null;
}

// Every Union-routed declaration must be present at the registry, and an exact
// declared version must be one of the registry's materialized versions, before
// npm is allowed to mutate anything.
async function verifyUnionAvailability({ rows, unionScopes, registryUrl, fetchImplementation }) {
  const unionRows = rows.filter((row) => unionScopes.includes(scopeOf(row.name) ?? ""));
  for (const row of unionRows) {
    let metadata;
    try {
      const response = await fetchImplementation(new URL(encodeURIComponent(row.name), registryUrl));
      if (response.status === 404) refuse("package-absent", { registry: registryUrl, package: row.name, spec: row.spec });
      if (!response.ok) refuse("registry-unreachable", { registry: registryUrl, package: row.name, diagnostic: `HTTP ${response.status}` });
      metadata = await response.json();
    } catch (error) {
      if (error instanceof ClosureRefusal) throw error;
      refuse("registry-unreachable", { registry: registryUrl, package: row.name, diagnostic: error.message });
    }
    if (EXACT_VERSION.test(row.spec) && !Object.hasOwn(metadata.versions ?? {}, row.spec)) {
      refuse("package-version-absent", {
        registry: registryUrl,
        package: row.name,
        spec: row.spec,
        availableVersions: Object.keys(metadata.versions ?? {}).sort(),
      });
    }
  }
  return unionRows.map(({ name }) => name).sort();
}

function npmrcLines({ publicRegistryUrl, registryUrl, scopes }) {
  return [`registry=${publicRegistryUrl}`, ...scopes.map((scope) => `@${scope}:registry=${registryUrl}`)];
}

async function materializeNpmrc({ consumer, lines }) {
  const path = join(consumer, ".npmrc");
  const text = `${lines.join("\n")}\n`;
  let prior = null;
  try {
    prior = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") refuse("consumer-manifest", { consumer, diagnostic: error.message });
  }
  const changed = prior !== text;
  if (changed) await writeFile(path, text);
  return { path, lines, changed, prior, priorLines: prior === null ? null : prior.split("\n").filter((line) => line !== "") };
}

async function restoreNpmrc(npmrc) {
  if (!npmrc.changed) return;
  try {
    if (npmrc.prior === null) await unlink(npmrc.path);
    else await writeFile(npmrc.path, npmrc.prior, "utf8");
  } catch (error) {
    refuse("consumer-configuration-rollback", { consumer: npmrc.path, diagnostic: error.message });
  }
}

async function mayHavePrecedentShrinkwrap(consumer) {
  try {
    await access(join(consumer, "npm-shrinkwrap.json"));
    return true;
  } catch (error) {
    // Only known absence makes package-lock authoritative for this preflight.
    // npm ci retains responsibility for inaccessible or malformed shrinkwraps.
    return error?.code !== "ENOENT";
  }
}

// `npm install` is intentionally not an implementation option here: it is
// permitted to rewrite the lock and therefore turns a committed closure into
// an observation made by the build machine.  The consumer's committed lock is
// the closure authority; npm ci both checks it against package.json and
// installs exactly that graph.
export async function readCommittedDependencyLock({ consumer, manifest }) {
  const path = join(consumer, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    refuse("committed-dependency-closure", { consumer, diagnostic: `package-lock.json is required and must be valid JSON: ${error.message}` });
  }
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2 || !lock.packages || typeof lock.packages !== "object") {
    refuse("committed-dependency-closure", { consumer, diagnostic: "package-lock.json does not contain an npm lockfile v2+ package graph" });
  }
  // Diagnose unambiguous exact runtime-pin defects before registry discovery
  // or consumer configuration changes. This is not a second npm resolver:
  // ranges, optional/accept overrides, overlapping dev declarations, workspace
  // links and non-plain versions remain npm ci's responsibility. npm also
  // prefers npm-shrinkwrap.json, so do not diagnose an ignored package-lock.
  // Root metadata alone is not proof that a locked version violates a declaration.
  const runtimePins = manifest && !await mayHavePrecedentShrinkwrap(consumer)
    ? manifest.dependencies ?? {} : {};
  const defects = [];
  for (const [name, spec] of Object.entries(runtimePins).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof spec !== "string" || !PLAIN_VERSION.test(spec)
        || Object.hasOwn(manifest.optionalDependencies ?? {}, name)
        || Object.hasOwn(manifest.acceptDependencies ?? {}, name)
        || Object.hasOwn(manifest.devDependencies ?? {}, name)) continue;
    const lockPath = `node_modules/${name}`;
    const entry = lock.packages[lockPath];
    if (entry?.link === true) continue;
    if (entry !== undefined && (typeof entry?.version !== "string" || !PLAIN_VERSION.test(entry.version))) continue;
    if (entry?.version !== spec) defects.push({
      name, kind: "dependency", spec, lockPath,
      lockedSpec: lock.packages[""]?.dependencies?.[name] ?? null,
      lockedVersion: entry?.version ?? null,
      reason: entry === undefined ? "locked-package-absent" : "exact-version-mismatch",
    });
  }
  if (defects.length > 0) refuse("committed-dependency-closure", {
    consumer,
    diagnostic: "package.json exact runtime dependencies disagree with package-lock.json",
    defects,
  });
  return Object.freeze({ path, lockfileVersion: lock.lockfileVersion, packages: Object.keys(lock.packages).length });
}

export function committedClosureInstallArguments() {
  return Object.freeze(["ci", "--no-audit", "--no-fund"]);
}

async function runInstall({ consumer, npmCommand }) {
  try {
    const { stdout } = await execute(npmCommand, committedClosureInstallArguments(), {
      cwd: consumer,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    refuse("installation", { consumer, diagnostic: (error.stderr || error.stdout || error.message).slice(-4000) });
  }
}

function provenanceOf(resolved, registryUrl) {
  if (typeof resolved !== "string") return "workspace";
  const origin = (candidate) => {
    try {
      return new URL(candidate).host;
    } catch {
      return null;
    }
  };
  if (origin(resolved) === origin(registryUrl)) return "union-private-registry";
  if (origin(resolved) === "registry.npmjs.org") return "public-npm";
  return origin(resolved) === null ? "workspace" : "other-registry";
}

async function readInstalledTree({ consumer, registryUrl }) {
  let lock;
  try {
    lock = JSON.parse(await readFile(join(consumer, "node_modules", ".package-lock.json"), "utf8"));
  } catch (error) {
    refuse("dependency-tree", { consumer, diagnostic: `installed tree is unreadable: ${error.message}` });
  }
  const provenance = { "union-private-registry": 0, "public-npm": 0, "other-registry": 0, workspace: 0 };
  const installed = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    provenance[provenanceOf(entry.resolved, registryUrl)] += 1;
    if (!installed.has(name)) installed.set(name, { version: entry.version, source: provenanceOf(entry.resolved, registryUrl) });
  }
  return { installedPackages: Object.keys(lock.packages ?? {}).filter((path) => path !== "").length, provenance, installed };
}

// Every declared bare import must resolve from the consumer's own membrane, in
// a child Node process whose resolution standpoint is the consumer directory.
// Node may resolve a file URL even when its export/main target does not exist.
// Check the target without evaluating package code before issuing a receipt.
async function verifyDeclaredImports({ consumer, rows }) {
  if (rows.length === 0) return [];
  const program = [
    "import { statSync } from 'node:fs';",
    "const rows=JSON.parse(process.argv[1]);",
    "for(const row of rows){",
    "try{row.resolved=import.meta.resolve(row.name);",
    "if(row.resolved.startsWith('file:')&&!statSync(new URL(row.resolved)).isFile()){throw new Error('resolved import target is not a file: '+row.resolved)}",
    "row.resolution=\"resolved\"}",
    "catch(error){if(error?.code===\"ERR_PACKAGE_PATH_NOT_EXPORTED\"){row.resolution=\"resolved-unexported-root\"}else{row.resolution=\"unresolved\";row.diagnostic=error.message}}",
    "}process.stdout.write(JSON.stringify(rows))",
  ].join("");
  const checked = await execute(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify(rows)], {
    cwd: consumer,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(checked.stdout);
}

export async function installConsumerDependencyClosure({
  consumerPath,
  registryUrl = "http://127.0.0.1:4873/",
  publicRegistryUrl = "https://registry.npmjs.org/",
  npmCommand = "npm",
  fetchImplementation = fetch,
}) {
  if (typeof consumerPath !== "string" || consumerPath.length === 0) {
    refuse("consumer-manifest", { consumer: consumerPath ?? null, diagnostic: "consumerPath must be a non-empty string" });
  }
  const consumer = resolve(consumerPath);
  const manifest = await readConsumerManifest(consumer);
  const lock = await readCommittedDependencyLock({ consumer, manifest });
  const rows = declaredDependencies(manifest);
  const unionScopes = await unionScopeRoster({ registryUrl, fetchImplementation });
  const unionPackages = await verifyUnionAvailability({ rows, unionScopes, registryUrl, fetchImplementation });
  const consumerScopes = [...new Set(rows.map((row) => scopeOf(row.name)).filter((scope) => scope !== null && unionScopes.includes(scope)))].sort();
  const npmrc = await materializeNpmrc({ consumer, lines: npmrcLines({ publicRegistryUrl, registryUrl, scopes: consumerScopes }) });
  try {
    const installOutput = await runInstall({ consumer, npmCommand });
    const tree = await readInstalledTree({ consumer, registryUrl });
    const verified = await verifyDeclaredImports({ consumer, rows });
    const defects = verified.filter((row) => row.resolution === "unresolved");
    if (defects.length > 0) {
      refuse("import-resolution", {
        consumer,
        defects: defects.map(({ name, kind, spec, diagnostic }) => ({ name, kind, spec, diagnostic })),
      });
    }
    return Object.freeze({
      type: "ConsumerDependencyClosureReceipt",
      version: 1,
      consumer,
      package: { name: manifest.name ?? null, version: manifest.version ?? null },
      registry: { union: registryUrl, public: publicRegistryUrl, unionScopes },
      npmrc: { ...npmrc, prior: undefined },
      closure: { lockfile: lock.path, lockfileVersion: lock.lockfileVersion, packageEntries: lock.packages },
      install: { command: `${npmCommand} ${committedClosureInstallArguments().join(" ")}`, output: installOutput.slice(-2000) },
      packages: { installed: tree.installedPackages, provenance: tree.provenance },
      unionPackages,
      declaredImports: verified.map((row) => ({
        name: row.name,
        kind: row.kind,
        spec: row.spec,
        resolution: row.resolution,
        version: tree.installed.get(row.name)?.version ?? null,
        source: tree.installed.get(row.name)?.source ?? null,
      })),
    });
  } catch (error) {
    await restoreNpmrc(npmrc);
    throw error;
  }
}
