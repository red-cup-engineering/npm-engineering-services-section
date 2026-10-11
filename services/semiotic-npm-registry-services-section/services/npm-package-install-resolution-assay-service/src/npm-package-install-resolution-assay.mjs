import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const EXACT_SURFACE = /^(?:@[^/@\s]+\/[^@/\s]+|[^@/\s]+)@([^\s]+)$/u;
const DEFAULT_REGISTRY = "http://127.0.0.1:4873/";

// This is deliberately an installation-resolution assay, rather than a
// "package works" assay. npm is allowed to resolve and unpack the declared
// closure, but lifecycle scripts are prohibited and no imported program runs.
export function dependencyResolutionInstallArguments({ registryUrl, surface }) {
  return Object.freeze([
    "install", surface,
    "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    "--registry", registryUrl,
  ]);
}

export function parseExactPackageSurface(surface) {
  if (typeof surface !== "string" || !EXACT_SURFACE.test(surface)) {
    throw new TypeError(`an exact npm package surface is required, received ${JSON.stringify(surface)}`);
  }
  const at = surface.lastIndexOf("@");
  return Object.freeze({ surface, name: surface.slice(0, at), version: surface.slice(at + 1) });
}

function diagnosticOf(result) {
  return [result?.stderr, result?.stdout, result?.message]
    .filter((part) => typeof part === "string" && part !== "")
    .join("\n")
    .slice(-8000);
}

export function classifyInstallResolutionFailure(result) {
  const diagnostic = diagnosticOf(result);
  if (result?.timedOut === true || result?.code === "ETIMEDOUT" || (result?.killed === true && result?.signal === "SIGTERM")) {
    return "timed-out";
  }
  if (/\bEUNSUPPORTEDPROTOCOL\b/u.test(diagnostic) || /(?:workspace|file|link):/u.test(diagnostic)) {
    return "local-only-protocol";
  }
  if (/\bETARGET\b/u.test(diagnostic) || /No matching version found/u.test(diagnostic)) {
    return "target-version-unavailable";
  }
  if (/\bEBADENGINE\b/u.test(diagnostic) || /\bERESOLVE\b/u.test(diagnostic) || /peer dependency|peer dep|engine /iu.test(diagnostic)) {
    return "peer-or-engine-resolution";
  }
  if (/\bEINTEGRITY\b|\bTAR_[A-Z_]+\b|tarball|integrity checksum|unexpected end of file/iu.test(diagnostic)) {
    return "tarball-retrieval-or-integrity";
  }
  return "other-resolution-failure";
}

async function defaultInstallImplementation({ command, arguments: args, cwd, timeoutMs }) {
  try {
    const { stdout, stderr } = await executeFile(command, args, {
      cwd,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error.message,
      exitCode: typeof error.code === "number" ? error.code : null,
      code: typeof error.code === "string" ? error.code : null,
      signal: error.signal ?? null,
      killed: error.killed === true,
      timedOut: error.code === "ETIMEDOUT" || (error.killed === true && error.signal === "SIGTERM"),
    };
  }
}

async function defaultConsumerFactory(surface) {
  const directory = await mkdtemp(join(tmpdir(), "npm-install-resolution-assay-"));
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "npm-install-resolution-assay-consumer",
    private: true,
    version: "0.0.0",
  })}\n`);
  return directory;
}

async function assayOne({ surface, registryUrl, npmCommand, timeoutMs, installImplementation, consumerFactory, cleanup }) {
  const parsed = parseExactPackageSurface(surface);
  const consumer = await consumerFactory(parsed.surface);
  try {
    const result = await installImplementation({
      command: npmCommand,
      arguments: dependencyResolutionInstallArguments({ registryUrl, surface: parsed.surface }),
      cwd: consumer,
      timeoutMs,
    });
    if (result?.ok === true) {
      return Object.freeze({
        package: parsed,
        status: "installed",
        command: Object.freeze([npmCommand, ...dependencyResolutionInstallArguments({ registryUrl, surface: parsed.surface })]),
        output: diagnosticOf(result),
      });
    }
    return Object.freeze({
      package: parsed,
      status: "failed",
      category: classifyInstallResolutionFailure(result),
      exitCode: result?.exitCode ?? null,
      diagnostic: diagnosticOf(result),
      command: Object.freeze([npmCommand, ...dependencyResolutionInstallArguments({ registryUrl, surface: parsed.surface })]),
    });
  } finally {
    await cleanup(consumer);
  }
}

async function boundedMap(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function assayPackageInstallResolution({
  packageSurfaces,
  registryUrl = DEFAULT_REGISTRY,
  npmCommand = "npm",
  concurrency = 4,
  timeoutMs = 120_000,
  installImplementation = defaultInstallImplementation,
  consumerFactory = defaultConsumerFactory,
  cleanup = (consumer) => rm(consumer, { recursive: true, force: true }),
} = {}) {
  if (!Array.isArray(packageSurfaces) || packageSurfaces.length === 0) throw new TypeError("packageSurfaces must be a non-empty array");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  const surfaces = [...new Set(packageSurfaces)].sort();
  surfaces.forEach(parseExactPackageSurface);
  const outcomes = await boundedMap(surfaces, concurrency, (surface) => assayOne({
    surface, registryUrl, npmCommand, timeoutMs, installImplementation, consumerFactory, cleanup,
  }));
  const failuresByCategory = {};
  for (const outcome of outcomes) {
    if (outcome.status === "failed") failuresByCategory[outcome.category] = (failuresByCategory[outcome.category] ?? 0) + 1;
  }
  return Object.freeze({
    type: "NpmPackageInstallResolutionAssayReceipt",
    version: 1,
    claim: "Dependency-resolution/install closure only: selected exact package surfaces were installed by npm with lifecycle scripts disabled. This does not establish runtime, import, or lifecycle correctness.",
    registry: registryUrl,
    controls: Object.freeze({ lifecycleScripts: "disabled", concurrency, timeoutMs }),
    outcomes: Object.freeze(outcomes),
    summary: Object.freeze({
      attempted: outcomes.length,
      installed: outcomes.filter((outcome) => outcome.status === "installed").length,
      failed: outcomes.filter((outcome) => outcome.status === "failed").length,
      failuresByCategory: Object.freeze(failuresByCategory),
    }),
  });
}
