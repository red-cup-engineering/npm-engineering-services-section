import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeJsnodeModuleEdges } from "@red-cup-engineering/jsnode-cross-package-module-edge-normalization-service";
import { observeJsnodePackageBody } from "@red-cup-engineering/jsnode-package-body-observation-service";
import { normalizeJsnodePackageDependencies } from "@red-cup-engineering/jsnode-package-dependency-normalization-service";
import { normalizeJsnodePackageIdentity } from "@red-cup-engineering/jsnode-package-identity-normalization-service";
import { normalizeJsnodePackageIdentityReferences } from "@red-cup-engineering/jsnode-package-identity-reference-normalization-service";
import { normalizeJsnodePackageManifest } from "@red-cup-engineering/jsnode-package-manifest-normalization-service";
import { projectJsnodePackageOwner } from "@red-cup-engineering/jsnode-package-owner-projection-service";

export async function normalizeJsnodePackageBody({ root = process.cwd(), apply = false } = {}) {
  const observed = await observeJsnodePackageBody({ root });
  const absoluteRoot = observed.root, packages = observed.packages;
  const duplicateOld = Object.entries(Object.groupBy(packages, ({ manifest }) => manifest.name ?? "")).filter(([name, rows]) => !name || rows.length > 1);
  if (duplicateOld.length) throw new Error("active package identities are ambiguous: " + duplicateOld.map(([name]) => name || "<unnamed>").join(", "));

  const identities = packages.map(({ path, manifest }) => {
    const ownerProjection = projectJsnodePackageOwner(path);
    const identity = normalizeJsnodePackageIdentity({ packageName: manifest.name, owner: ownerProjection.owner });
    const normalizedManifest = normalizeJsnodePackageManifest({ manifest, identity });
    return { ...identity, version: normalizedManifest.version, path, root: absoluteRoot, ownerProjection };
  });
  const collisions = Object.entries(Object.groupBy(identities, ({ name }) => name)).filter(([, rows]) => rows.length > 1);
  if (collisions.length) throw new Error("normalized package identities collide: " + collisions.map(([name, rows]) => name + " <= " + rows.map(({ priorName, path }) => priorName + " at " + path).join(" | ")).join("; "));

  const identitiesByName = new Map(identities.map((identity) => [identity.priorName, identity]));
  const identitiesByDirectory = new Map(identities.map((identity) => [dirname(resolve(absoluteRoot, identity.path)), identity]));
  const byLeaf = Object.groupBy(identities, ({ leaf }) => leaf);
  for (const [leaf, rows] of Object.entries(byLeaf)) if (rows.length === 1) identitiesByName.set("@emsenn/" + leaf, rows[0]);
  const replacements = [...identitiesByName.entries()].map(([before, identity]) => [before, identity.name]).filter(([before, after]) => before !== after).sort((a, b) => b[0].length - a[0].length);

  const rows = packages.map(({ path, manifest }) => {
    const identity = identitiesByName.get(manifest.name);
    let after = normalizeJsnodePackageManifest({ manifest, identity });
    after = normalizeJsnodePackageDependencies({ manifest: after, manifestPath: path, root: absoluteRoot, providersByName: identitiesByName, providersByDirectory: identitiesByDirectory });
    const { "x-semiotic-voxel": voxel, "x-agentic-metro-enterprise": enterprise, ...cleaned } = after;
    return { path, before: manifest, after: cleaned, identity };
  });
  const rowByPath = new Map(rows.map((row) => [row.path, row]));
  const sourceRewrites = [], edges = new Set();

  for (const path of observed.sourceFiles) {
    const before = await readFile(resolve(absoluteRoot, path), "utf8");
    const carriers = rows.map((row) => ({ path: row.path, directory: dirname(row.path), name: row.after.name, version: row.after.version, exports: row.after.exports }));
    const articulated = await normalizeJsnodeModuleEdges({ root: absoluteRoot, path, source: before, carriers });
    if (articulated.consumerPath) {
      const consumer = rowByPath.get(articulated.consumerPath);
      if (consumer && Object.keys(articulated.consumerDependencies).length) consumer.after.dependencies = { ...consumer.after.dependencies, ...articulated.consumerDependencies };
    }
    for (const projection of articulated.providerExports) {
      const provider = rowByPath.get(projection.providerPath);
      if (provider) provider.after.exports = projection.exports;
    }
    for (const edge of articulated.edges) edges.add(edge);
    const after = normalizeJsnodePackageIdentityReferences({ source: articulated.source, replacements });
    if (after !== before) sourceRewrites.push({ path, before, after });
  }

  const manifestRewrites = rows.filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
  if (apply) await Promise.all([
    ...manifestRewrites.map(({ path, after }) => writeFile(resolve(absoluteRoot, path), JSON.stringify(after, null, 2) + "\n", "utf8")),
    ...sourceRewrites.map(({ path, after }) => writeFile(resolve(absoluteRoot, path), after, "utf8")),
  ]);
  return Object.freeze({
    type: "JsnodePackageBodyNormalizationReceipt",
    version: 1,
    applied: apply,
    packages: rows.length,
    manifestFilesChanged: manifestRewrites.length,
    identitiesChanged: rows.filter(({ before, after }) => before.name !== after.name).length,
    identityAliasesKnown: replacements.length,
    consumerFilesChanged: sourceRewrites.length,
    packageContractEdgesChanged: edges.size,
  });
}
