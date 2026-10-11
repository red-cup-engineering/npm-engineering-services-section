import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const MAXIMUM_PARALLELISM = 32;

function operation(dependencies, name) {
  if (typeof dependencies?.[name] !== "function") throw new TypeError(`dependencies.${name} must be a function`);
  return dependencies[name];
}

function dependenciesOf(dependencies) {
  return Object.freeze({
    discover: operation(dependencies, "discover"),
    validateReleaseBindings: operation(dependencies, "validateReleaseBindings"),
    projectReleaseManifest: operation(dependencies, "projectReleaseManifest"),
    projectCarrier: operation(dependencies, "projectCarrier"),
    pack: operation(dependencies, "pack"),
    assemble: operation(dependencies, "assemble"),
    verify: operation(dependencies, "verify"),
    activate: operation(dependencies, "activate"),
  });
}

function leaseBrokerOf(leaseBroker) {
  if (typeof leaseBroker?.acquire !== "function") throw new TypeError("leaseBroker.acquire must be a function");
  return leaseBroker;
}

function parallelism(value, requestedParallelism) {
  if (!Number.isInteger(value) || value < 1 || value > requestedParallelism) throw new Error("compute lease returned invalid parallelism");
  return value;
}

async function selectedDirectories({ packageDirectories, discoveryRequest, discover }) {
  if (packageDirectories !== undefined) {
    if (!Array.isArray(packageDirectories)) throw new TypeError("packageDirectories must be an array");
    return packageDirectories.map((directory) => resolve(directory));
  }
  const report = await discover(discoveryRequest ?? {});
  if (!Array.isArray(report?.found)) throw new Error("discovery did not return found package directories");
  if (report.collisions?.length) throw new Error(`package discovery collisions: ${report.collisions.map(({ identity }) => identity).join(", ")}`);
  return report.found.map(({ directory }) => resolve(directory));
}

async function prepareRelease({ directory, artifactDirectory, dependencies }) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const release = await dependencies.projectReleaseManifest(manifest);
  const working = await mkdtemp(join(artifactDirectory, ".carrier-"));
  try {
    const carrierDirectory = join(working, "carrier");
    await dependencies.projectCarrier({ sourceDirectory: directory, targetDirectory: carrierDirectory, manifest: release.manifest, rewriteManifest: release.rewrite });
    const packed = await dependencies.pack({ carrierDirectory, destinationDirectory: working });
    const artifactPath = join(artifactDirectory, `${randomUUID()}.tgz`);
    await rename(packed.artifactPath, artifactPath);
    return Object.freeze({ manifest: release.manifest, artifactPath });
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

async function runBounded(items, maximumParallelism, work) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      results.push(await work(item));
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximumParallelism, items.length) }, worker));
  return results;
}

/**
 * Coordinate supplied capabilities. This deliberately does not discover,
 * project, pack, assemble, verify, activate, or lease capacity itself.
 */
export async function coordinateNpmRegistryRelease({
  dependencies,
  leaseBroker,
  packageDirectories,
  discoveryRequest,
  outputDirectory,
  registryUrl,
  baseRegistryDirectory,
  excludedBaseReleases = [],
  concurrency,
  activation,
} = {}) {
  const operations = dependenciesOf(dependencies);
  const broker = leaseBrokerOf(leaseBroker);
  const directories = await selectedDirectories({ packageDirectories, discoveryRequest, discover: operations.discover });
  await mkdir(resolve(outputDirectory), { recursive: true });
  const requestedParallelism = concurrency ?? MAXIMUM_PARALLELISM;
  if (!Number.isInteger(requestedParallelism) || requestedParallelism < 1 || requestedParallelism > MAXIMUM_PARALLELISM) throw new TypeError("concurrency must be an integer from 1 through 32");
  const lease = await broker.acquire(Object.freeze({ workUnits: directories.length, requestedParallelism }));
  const grantedParallelism = parallelism(lease?.parallelism, requestedParallelism);
  if (typeof lease?.provider !== "string" || !lease.provider || !lease.settlement) throw new Error("compute lease must declare provider and settlement");
  const artifactDirectory = await mkdtemp(join(tmpdir(), "npm-registry-prepared-artifacts-"));
  let failed = false;
  try {
    const manifests = await Promise.all(directories.map(async (directory) => ({ directory, manifest: JSON.parse(await readFile(join(directory, "package.json"), "utf8")) })));
    await operations.validateReleaseBindings({ packages: manifests, baseRegistryDirectory });
    const releases = await runBounded(directories, grantedParallelism, (directory) => prepareRelease({ directory, artifactDirectory, dependencies: operations }));
    const candidate = await operations.assemble({ releases, outputDirectory, registryUrl, baseRegistryDirectory, excludedBaseReleases, compute: { provider: lease.provider, parallelism: grantedParallelism, settlement: lease.settlement } });
    const verification = await operations.verify({ snapshotDirectory: outputDirectory, receipt: candidate });
    const verifiedCandidate = Object.freeze({ ...candidate, verification });
    if (activation === undefined) return verifiedCandidate;
    if (typeof activation.candidateName !== "string" || !activation.candidateName) throw new TypeError("activation.candidateName is required");
    const { candidateName, ...activationRequest } = activation;
    return Object.freeze({ ...verifiedCandidate, activation: await operations.activate({ ...activationRequest, candidate: { ...verifiedCandidate, name: candidateName } }) });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await rm(artifactDirectory, { recursive: true, force: true }); } catch (error) { if (!failed) throw error; }
    if (typeof lease?.release === "function") {
      try { await lease.release(); } catch (error) { if (!failed) throw error; }
    }
  }
}
