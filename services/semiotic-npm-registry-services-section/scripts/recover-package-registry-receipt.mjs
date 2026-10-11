import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { verifyArtifactFile } from "@red-cup-engineering/npm-registry-services-section/npm-artifact-integrity-service";

const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`));
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function versionOrder(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// The served metadata and tarballs are sufficient to reconstruct the receipt.
// A missing receipt must not make an otherwise intact registry permanently
// unpublishable.
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
      let verification;
      try {
        verification = await verifyArtifactFile(artifactPath, {
          shasum: manifest.dist?.shasum,
          integrity: manifest.dist?.integrity,
        });
      } catch (error) {
        if (error instanceof TypeError) throw new Error(`registry tarball digest mismatch: ${metadata.name}@${version}`);
        throw error;
      }
      if (!verification.ok) {
        throw new Error(`registry tarball digest mismatch: ${metadata.name}@${version}`);
      }
      const measured = verification.measurement;
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
