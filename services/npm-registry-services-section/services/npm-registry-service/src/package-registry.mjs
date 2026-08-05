import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`));
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function artifactNames(name, version) {
  const leaf = name.slice(name.indexOf("/") + 1);
  const scope = name.slice(1, name.indexOf("/"));
  return { leaf, relative: `tarballs/${scope}/${leaf}/-/${leaf}-${version}.tgz` };
}

async function digest(path) {
  const bytes = await readFile(path);
  return {
    bytes: bytes.byteLength,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

// The served metadata and tarballs are sufficient to reconstruct the receipt.
// Keep that recovery here because the receipt is an index, not an irreplaceable
// second copy of the catalogue.  A missing receipt must not make an otherwise
// intact registry permanently unpublishable.
export async function recoverPackageRegistryReceipt({ registryDirectory, registryUrl }) {
  const root = resolve(registryDirectory);
  const base = new URL(registryUrl);
  if (!/^https?:$/u.test(base.protocol)) throw new TypeError("registryUrl must be absolute HTTP(S)");
  const metadataDirectory = join(root, "metadata");
  const files = (await readdir(metadataDirectory)).filter((file) => file.endsWith(".json")).sort();
  const packages = [];
  for (const file of files) {
    const metadata = JSON.parse(await readFile(join(metadataDirectory, file), "utf8"));
    if (!PACKAGE_NAME.test(metadata.name ?? "")) throw new Error(`registry metadata has invalid package identity: ${file}`);
    for (const [version, manifest] of Object.entries(metadata.versions ?? {})) {
      if (!VERSION.test(version) || manifest?.name !== metadata.name || manifest?.version !== version) {
        throw new Error(`registry metadata has invalid release: ${metadata.name}@${version}`);
      }
      let artifact;
      try { artifact = decodeURIComponent(new URL(manifest.dist?.tarball).pathname).replace(/^\/+/, ""); } catch {
        throw new Error(`registry metadata has invalid tarball URL: ${metadata.name}@${version}`);
      }
      if (!artifact.startsWith("tarballs/")) throw new Error(`registry metadata has non-catalog tarball: ${metadata.name}@${version}`);
      const artifactPath = resolve(root, artifact);
      if (!inside(root, artifactPath) || !(await exists(artifactPath))) throw new Error(`registry tarball is absent: ${metadata.name}@${version}`);
      const measured = await digest(artifactPath);
      if (manifest.dist.shasum !== measured.shasum || manifest.dist.integrity !== measured.integrity) {
        throw new Error(`registry tarball digest mismatch: ${metadata.name}@${version}`);
      }
      packages.push({ name: metadata.name, version, tarball: new URL(artifact, base).href, artifact, ...measured });
    }
  }
  packages.sort((left, right) => left.name.localeCompare(right.name) || versionOrder(left.version, right.version));
  const scopes = [...new Set(packages.map(({ name }) => name.slice(1, name.indexOf("/"))))].sort();
  return {
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: base.href,
    packages,
    packageCount: new Set(packages.map(({ name }) => name)).size,
    scopes,
    compute: { provider: "urn:provider:catalog-recovery", parallelism: 1, settlement: { type: "RecoveredFromVerifiedCatalogArtifacts" } },
  };
}

async function projectCarrier(source, target, manifest, rewriteManifest) {
  const instanceTerritories = [
    "/content/assets/legacy/",
    "/content/dispatches/",
    "/content/exchanges/",
    "/content/packets/",
    "/content/proposals/",
    "/content/requirement-events/",
    "/content/retired-carriers/",
    "/content/runtime/",
    "/content/tasks/",
  ];
  async function projectDirectory(from, to, root = false, relativePath = "") {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if ([".git", "node_modules", "data", "test", "tests", "cache", ".tmp", ".archive"].includes(entry.name)) continue;
      const entryRelative = `${relativePath}/${entry.name}`;
      const framed = `${entryRelative}/`;
      if (instanceTerritories.some((territory) => framed.includes(territory))) continue;
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (root && rewriteManifest && entry.name === "package.json") continue;
      if (entry.isDirectory()) {
        if (!root && await exists(join(sourcePath, "package.json"))) continue;
        await projectDirectory(sourcePath, targetPath, false, entryRelative);
      } else if (entry.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), targetPath);
      } else if ((await lstat(sourcePath)).isFile()) {
        try { await link(sourcePath, targetPath); } catch (error) {
          if (error?.code !== "EXDEV") throw error;
          await copyFile(sourcePath, targetPath);
        }
      }
    }
  }
  await projectDirectory(source, target, true);
  if (rewriteManifest) await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function pack(directory, destination, manifest, rewriteManifest) {
  const working = await mkdtemp(join(destination, ".pack-"));
  const cache = await mkdtemp(join(tmpdir(), "npm-registry-pack-cache-"));
  try {
    const projection = join(working, "carrier");
    await projectCarrier(directory, projection, manifest, rewriteManifest);
    const { stdout, stderr } = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", working], {
      cwd: projection,
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_loglevel: "error" },
      maxBuffer: 16 * 1024 * 1024,
    });
    const artifacts = (await readdir(working)).filter((entry) => entry.endsWith(".tgz"));
    if (artifacts.length !== 1) throw new Error(`npm pack artifact observation for ${directory} expected one .tgz, observed ${JSON.stringify({ artifacts, stdout, stderr })}`);
    const artifact = join(destination, `${randomUUID()}.tgz`);
    await rename(join(working, artifacts[0]), artifact);
    return artifact;
  } finally {
    await rm(working, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
}

async function releasedManifest(manifest, packageVersions, baseRegistry) {
  let release = manifest;
  // Custom x- fields are a house dialect no npm tooling understands; published
  // packages are plain npm packages, so they never carry them.
  for (const field of ["x-semiotic-voxel", "x-agentic-metro-enterprise"]) {
    if (field in manifest) {
      if (release === manifest) release = structuredClone(manifest);
      delete release[field];
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [provider, requested] of Object.entries(manifest[field] ?? {})) {
      if (typeof requested !== "string" || !requested.startsWith("workspace:")) continue;
      let selected = packageVersions.get(provider);
      if (selected === undefined && baseRegistry !== null) {
        const metadataPath = join(baseRegistry, "metadata", `${encodeURIComponent(provider)}.json`);
        if (await exists(metadataPath)) {
          const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
          selected = metadata["dist-tags"]?.latest;
          if (!VERSION.test(selected ?? "") || metadata.versions?.[selected]?.name !== provider) {
            throw new Error(`workspace provider has no exact latest release: ${provider}`);
          }
          packageVersions.set(provider, selected);
        }
      }
      if (selected === undefined) throw new Error(`workspace provider is absent from the admitted release catalog: ${provider}`);
      if (release === manifest) release = structuredClone(manifest);
      release[field][provider] = selected;
    }
  }
  return { manifest: release, rewrite: release !== manifest };
}

async function procureComputeLease({ computeMarket, packageCount, concurrency }) {
  const maximumParallelism = concurrency ?? Math.min(availableParallelism(), 32);
  if (!Number.isInteger(maximumParallelism) || maximumParallelism < 1 || maximumParallelism > 32) {
    throw new TypeError("concurrency must be an integer from 1 through 32");
  }
  if (!computeMarket) {
    return Object.freeze({
      provider: "urn:provider:local-node-process",
      parallelism: maximumParallelism,
      settlement: { type: "SelfSuppliedComputeCapacity", measuredAvailableParallelism: availableParallelism() },
    });
  }
  if (typeof computeMarket.procure !== "function") throw new TypeError("computeMarket.procure must be a function");
  const lease = await computeMarket.procure(Object.freeze({
    type: "ComputeCapacityDemand",
    resource: "cpu-process-slot",
    taskClass: "npm-package-artifact-fabrication",
    workUnits: packageCount,
    maximumParallelism,
  }));
  if (!Number.isInteger(lease?.parallelism) || lease.parallelism < 1 || lease.parallelism > maximumParallelism) {
    throw new Error("compute market returned an invalid parallelism lease");
  }
  if (typeof lease.provider !== "string" || !lease.provider || !lease.settlement) {
    throw new Error("compute market returned an unowned or unsettled lease");
  }
  return lease;
}

function releaseSelector(value) {
  if (typeof value !== "string") throw new TypeError("excluded base release must be an exact package@version selector");
  const boundary = value.lastIndexOf("@");
  const name = value.slice(0, boundary), version = value.slice(boundary + 1);
  if (!PACKAGE_NAME.test(name) || !VERSION.test(version)) throw new TypeError("excluded base release must be an exact package@version selector");
  return { name, version };
}

function versionOrder(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// The workspace: protocol is a pnpm-only specifier — no plain npm client
// resolves it. Every release this builder ever fabricates gets it rewritten
// (releasedManifest, above); this is the second, independent gate: a full
// scan of every metadata file about to ship, including ones only *carried*
// in from a base registry rather than freshly packed this run, so a release
// contaminated by an older build (or a future regression) can never leave
// this function's care unnoticed. This is what the provide-npm-registry.rml
// contract already promises ("clean installs require no workspace or
// local-path dependency protocol") — this makes that promise checked, not
// merely asserted.
async function refuseSurvivingWorkspaceProtocol(stagingMetadataDirectory) {
  const violations = [];
  let files;
  try { files = await readdir(stagingMetadataDirectory); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const metadata = JSON.parse(await readFile(join(stagingMetadataDirectory, file), "utf8"));
    for (const [version, manifest] of Object.entries(metadata.versions ?? {})) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dependency, constraint] of Object.entries(manifest?.[field] ?? {})) {
          if (typeof constraint === "string" && constraint.startsWith("workspace:")) {
            violations.push({ name: metadata.name, version, field, dependency, constraint });
          }
        }
      }
    }
  }
  if (violations.length > 0) {
    const description = violations.map((v) => `${v.name}@${v.version} (${v.field}) ${v.dependency}@${v.constraint}`).join(", ");
    throw new Error(`registry build refused: workspace: protocol survives into published metadata: ${description}`);
  }
}

async function excludeBaseRelease(staging, entries, selector) {
  const removed = entries.filter(({ name, version }) => name === selector.name && version === selector.version);
  for (const entry of removed) await rm(join(staging, entry.artifact), { force: true });
  const metadataPath = join(staging, "metadata", `${encodeURIComponent(selector.name)}.json`);
  if (await exists(metadataPath)) {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata.versions?.[selector.version];
    const remaining = Object.keys(metadata.versions ?? {}).sort(versionOrder);
    if (remaining.length === 0) await rm(metadataPath);
    else {
      metadata["dist-tags"] = { ...metadata["dist-tags"], latest: remaining.at(-1) };
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    }
  }
  return entries.filter(({ name, version }) => name !== selector.name || version !== selector.version);
}

export async function buildPackageRegistry({ packageDirectories, outputDirectory, registryUrl, baseRegistryDirectory, excludedBaseReleases = [], concurrency, computeMarket }) {
  const base = new URL(registryUrl);
  if (!/^https?:$/u.test(base.protocol)) throw new TypeError("registryUrl must be absolute HTTP(S)");
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("registry artifact territory must be empty");
  const baseRegistry = baseRegistryDirectory === undefined ? null : resolve(baseRegistryDirectory);
  if (baseRegistry === output) throw new Error("base registry and output registry must be different territories");
  const packages = [];
  for (const source of packageDirectories) {
    const directory = resolve(source);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (!PACKAGE_NAME.test(manifest.name ?? "") || manifest.name.startsWith("@emsenn/")) throw new Error(`package identity is not sovereign: ${manifest.name ?? directory}`);
    if (!VERSION.test(manifest.version ?? "")) throw new Error(`package version is not exact: ${manifest.name}`);
    packages.push({ directory, manifest });
  }
  const collisions = Object.entries(Object.groupBy(packages, ({ manifest }) => `${manifest.name}@${manifest.version}`)).filter(([, rows]) => rows.length > 1);
  if (collisions.length) throw new Error(`duplicate package versions: ${collisions.map(([identity]) => identity).join(", ")}`);
  packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  const packageVersions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
  for (const candidate of packages) candidate.release = await releasedManifest(candidate.manifest, packageVersions, baseRegistry);
  const computeLease = await procureComputeLease({ computeMarket, packageCount: packages.length, concurrency });
  let leaseReleased = false;
  async function releaseComputeLease() {
    if (leaseReleased) return;
    leaseReleased = true;
    if (typeof computeLease.release === "function") await computeLease.release();
  }
  const staging = await mkdtemp(join(output, ".fabricating-"));
  const baseReceipt = baseRegistry === null ? null : JSON.parse(await readFile(join(baseRegistry, "registry-receipt.json"), "utf8"));
  let entries = baseReceipt === null ? [] : structuredClone(baseReceipt.packages ?? []);
  const exclusions = excludedBaseReleases.map(releaseSelector);
  try {
    if (baseRegistry !== null) {
      for (const entry of await readdir(baseRegistry)) await cp(join(baseRegistry, entry), join(staging, entry), { recursive: true, errorOnExist: true, force: false });
      for (const exclusion of exclusions) entries = await excludeBaseRelease(staging, entries, exclusion);
    }
    let nextPackage = 0;
    async function fabricateNext() {
      while (nextPackage < packages.length) {
        const { directory, manifest, release } = packages[nextPackage++];
      const temporaryArtifact = await pack(directory, staging, release.manifest, release.rewrite);
      const names = artifactNames(manifest.name, manifest.version);
      const target = join(staging, names.relative);
      await mkdir(dirname(target), { recursive: true });
      await rename(temporaryArtifact, target);
      const measured = await digest(target);
      const tarball = new URL(names.relative, base).href;
      const versionMetadata = {
        ...release.manifest,
        dist: { tarball, shasum: measured.shasum, integrity: measured.integrity },
      };
      const metadataPath = join(staging, "metadata", `${encodeURIComponent(manifest.name)}.json`);
      const priorMetadata = await exists(metadataPath) ? JSON.parse(await readFile(metadataPath, "utf8")) : null;
      const priorVersion = priorMetadata?.versions?.[manifest.version];
      if (priorVersion && priorVersion.dist?.integrity !== measured.integrity) throw new Error(`package release collision: ${manifest.name}@${manifest.version}`);
      const metadata = {
        _id: manifest.name,
        name: manifest.name,
        "dist-tags": { latest: manifest.version },
        versions: { ...(priorMetadata?.versions ?? {}), [manifest.version]: versionMetadata },
      };
      await mkdir(dirname(metadataPath), { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      const priorEntry = entries.findIndex((entry) => entry.name === manifest.name && entry.version === manifest.version);
      if (priorEntry >= 0) entries.splice(priorEntry, 1);
      entries.push({
        name: manifest.name,
        version: manifest.version,
        tarball,
        artifact: names.relative,
        ...measured,
      });
      }
    }
    await Promise.all(Array.from({ length: Math.min(computeLease.parallelism, packages.length) }, () => fabricateNext()));
    await refuseSurvivingWorkspaceProtocol(join(staging, "metadata"));
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const scopes = [...new Set(entries.map(({ name }) => name.slice(1, name.indexOf("/"))))].sort();
    const npmrc = [`registry=https://registry.npmjs.org/`, ...scopes.map((scope) => `@${scope}:registry=${base.href}`), ""].join("\n");
    await writeFile(join(staging, "client.npmrc"), npmrc);
    // `packages` is version-release entries (one package can carry several
    // releases across incremental base-registry builds); `packageCount` is
    // the count of distinct package names, which is what has one metadata
    // file each on disk. Reporting `packages.length` as if it were a package
    // count is the exact confusion that produced defect 4 — a receipt whose
    // headline number didn't match `ls metadata | wc -l`.
    const packageCount = new Set(entries.map((entry) => entry.name)).size;
    const receipt = {
      type: "SemioticVoxelPackageRegistryReceipt",
      version: 2,
      registry: base.href,
      packages: entries,
      packageCount,
      scopes,
      compute: {
        provider: computeLease.provider,
        parallelism: computeLease.parallelism,
        settlement: computeLease.settlement,
      },
    };
    await writeFile(join(staging, "registry-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    for (const entry of await readdir(staging)) await rename(join(staging, entry), join(output, entry));
    await rm(staging, { recursive: true, force: true });
    await releaseComputeLease();
    return receipt;
  } catch (error) {
    // Cleanup must never mask the build's real failure: sibling pack workers
    // may still be writing into staging when the first error rejects the
    // Promise.all, so removal can race them and throw ENOTEMPTY itself.
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    await releaseComputeLease();
    throw error;
  }
}

function contentType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".tgz")) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

export function createPackageRegistryServer({ registryDirectory }) {
  const root = resolve(registryDirectory);
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://registry.invalid");
      if (url.pathname === "/-/ping") {
        response.writeHead(200, { "content-type": "application/json" }).end(request.method === "HEAD" ? undefined : "{}\n");
        return;
      }
      if (url.pathname === "/-/whoami") {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer realm=private-npm-registry" }).end(request.method === "HEAD" ? undefined : '{"error":"unauthorized"}\n');
        return;
      }
      const target = await resolvePackageRegistryRequest({ registryDirectory: root, requestPath: url.pathname });
      if (!target) {
        response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}\n');
        return;
      }
      const type = contentType(target);
      if (type === "application/json" && decodeURIComponent(url.pathname).startsWith("/@")) {
        const metadata = rewriteMetadataTarballOrigins(JSON.parse(await readFile(target, "utf8")), new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).origin);
        const body = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
        response.writeHead(200, { "content-type": type, "content-length": body.byteLength, "cache-control": "no-cache" });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      response.writeHead(200, { "content-type": type, "content-length": (await stat(target)).size, "cache-control": "public, immutable" });
      if (request.method === "HEAD") response.end();
      else createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(`${JSON.stringify({ error: error.message })}\n`);
    }
  });
}

export function rewriteMetadataTarballOrigins(metadata, origin) {
  const rewritten = structuredClone(metadata);
  for (const version of Object.values(rewritten.versions ?? {})) {
    if (typeof version?.dist?.tarball === "string") {
      const artifact = new URL(version.dist.tarball).pathname;
      version.dist.tarball = new URL(artifact, origin).href;
    }
  }
  return rewritten;
}

export async function resolvePackageRegistryRequest({ registryDirectory, requestPath }) {
  const root = resolve(registryDirectory);
  const decoded = decodeURIComponent(requestPath.replace(/^\/+/, ""));
  const target = decoded.startsWith("@") && !decoded.includes(".tgz")
    ? join(root, "metadata", `${encodeURIComponent(decoded)}.json`)
    : resolve(root, decoded);
  if (!inside(root, target) || !(await exists(target)) || !(await stat(target)).isFile()) return null;
  return target;
}
