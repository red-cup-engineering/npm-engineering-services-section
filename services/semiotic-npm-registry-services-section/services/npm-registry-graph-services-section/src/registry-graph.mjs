
import { openNpmRegistryQuerySource } from "@red-cup-engineering/npm-registry-query-service";
import { maxSatisfying, valid, validRange } from "semver";
import { sha256Digest, sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

// A registry graph is one chart in the firm's atlas, and its tiers are
// independent dimensions that must not collapse into a single edge set:
// dependency pins, snapshot lineage, and build witness each keep their own
// namespace. A node's address keeps
// two legs — the package surface (name@version) and the content-addressable
// integrity digest — as separate coordinates, never merged.
const GRAPH_TYPE = "NpmRegistryGraph";
const RECEIPT_TYPE = "SemioticVoxelPackageRegistryReceipt";
const DEPENDENCY_RELATIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function packageSurface(name, version) {
  return `${name}@${version}`;
}

function packageScope(name) {
  const match = /^@([^/]+)\//.exec(name);
  return match ? match[1] : null;
}

async function readMetadata(name, source, metadataCache) {
  let metadataBytes = metadataCache.get(name);
  if (metadataBytes === undefined) {
    const document = await source.packument(name);
    if (document === null) throw new Error(`registry has no packument for ${name}`);
    metadataBytes = document.bytes;
    metadataCache.set(name, metadataBytes);
  }
  return { metadataBytes, metadata: JSON.parse(metadataBytes.toString("utf8")) };
}

async function readVersionManifest(entry, source, metadataCache) {
  const { metadataBytes, metadata } = await readMetadata(entry.name, source, metadataCache);
  const manifest = metadata.versions?.[entry.version];
  if (metadata.name !== entry.name || manifest?.name !== entry.name || manifest?.version !== entry.version) {
    throw new Error(`package metadata identity does not match the requested package: ${entry.name}@${entry.version}`);
  }
  const checkArtifact = entry.integrity != null || entry.shasum != null;
  if (checkArtifact && (manifest.dist?.integrity !== entry.integrity || manifest.dist?.shasum !== entry.shasum)) {
    throw new Error(`package metadata artifact does not match registry receipt: ${entry.name}@${entry.version}`);
  }
  return { manifest, metadataSha256: sha256Digest(metadataBytes) };
}

// A latest-set graph deliberately contains one selected release per package.
// It is not an npm resolver: an older *published* exact release remains
// resolvable. This proves metadata availability only, not a full runtime
// installation of its transitive closure.
async function publishedVersion(name, version, source, metadataCache) {
  try {
    const { metadata } = await readMetadata(name, source, metadataCache);
    return metadata.versions?.[version] ?? null;
  } catch (error) {
    if (error instanceof Error && error.message === `registry has no packument for ${name}`) return null;
    throw error;
  }
}

function dependencyRequest(name, constraint) {
  if (typeof constraint !== "string") return { name, constraint };
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(constraint);
  return alias === null
    ? { name, constraint }
    : { name: alias[1], constraint: alias[2] };
}

async function resolvePublishedDependency(name, constraint, source, metadataCache) {
  const request = dependencyRequest(name, constraint);
  try {
    const { metadata } = await readMetadata(request.name, source, metadataCache);
    const versions = Object.keys(metadata.versions ?? {});
    let version = valid(request.constraint);
    if (version === null) {
      const range = validRange(request.constraint);
      version = range === null
        ? metadata["dist-tags"]?.[request.constraint] ?? null
        : maxSatisfying(versions, range);
    }
    if (version === null || metadata.versions?.[version] === undefined) return null;
    return { name: request.name, version, manifest: metadata.versions[version] };
  } catch (error) {
    if (error instanceof Error && error.message === `registry has no packument for ${request.name}`) return null;
    throw error;
  }
}

function isPublishedLocalOnlyProtocol(constraint) {
  return typeof constraint === "string" && /^(?:workspace|file|link):/u.test(constraint);
}

// "name" or "name@1.2.3" or {name, version} — scoped names keep their leading @.
function requestedPackage(value) {
  if (typeof value === "object" && value !== null) return { name: value.name, version: value.version };
  const text = String(value);
  const at = text.lastIndexOf("@");
  if (at > 0) return { name: text.slice(0, at), version: text.slice(at + 1) };
  return { name: text, version: undefined };
}

// Works over any npm registry. With no package list, the registry must be one
// of ours: the package set and internal scopes come from its build receipt
// (registry-receipt.json). With an explicit `packages` list (names, name@version,
// or {name, version}), any registry works — versions default to dist-tags.latest,
// and `internalScopes` says which scopes must resolve inside the graph.
export async function deriveRegistryGraph({ registryRoot, registryUrl, packages, internalScopes, fetchImplementation = fetch } = {}) {
  const source = openNpmRegistryQuerySource({ registryRoot, registryUrl, fetchImplementation });
  const metadataCache = new Map();

  let receipt = null;
  let receiptSha256 = null;
  let entries;
  if (packages === undefined) {
    const receiptDocument = await source.receipt();
    if (receiptDocument === null) throw new Error("registry has no build receipt; pass an explicit `packages` list for registries that are not ours");
    const receiptBytes = receiptDocument.bytes;
    receipt = receiptDocument.value;
    if (receipt?.type !== RECEIPT_TYPE || !Array.isArray(receipt.packages) || !Array.isArray(receipt.scopes)) {
      throw new Error("registry has no recognized build receipt; pass an explicit `packages` list for registries that are not ours");
    }
    receiptSha256 = sha256Digest(receiptBytes);
    entries = [...receipt.packages];
  } else {
    if (!Array.isArray(packages) || packages.length === 0) throw new TypeError("`packages` must be a non-empty array");
    entries = [];
    for (const value of packages.map(requestedPackage)) {
      const release = await source.release(value.name, value.version);
      const version = release.version;
      if (typeof version !== "string") throw new Error(`registry names no latest version for ${value.name}; request an explicit version`);
      const manifest = release.manifest;
      if (manifest === null) throw new Error(`registry has no ${value.name}@${version}`);
      entries.push({
        name: value.name,
        version,
        artifact: manifest.dist?.tarball ?? null,
        bytes: null,
        shasum: manifest.dist?.shasum ?? null,
        integrity: manifest.dist?.integrity ?? null,
      });
    }
  }
  const ownedScopes = new Set(internalScopes ?? receipt?.scopes ?? []);

  entries.sort((a, b) =>
    packageSurface(a.name, a.version).localeCompare(packageSurface(b.name, b.version)),
  );
  const nodes = [];
  const nodesBySurface = new Map();
  for (const entry of entries) {
    const { manifest, metadataSha256 } = await readVersionManifest(entry, source, metadataCache);
    const node = {
      address: Object.freeze({
        packageSurface: packageSurface(entry.name, entry.version),
        contentIntegrity: entry.integrity,
        shasum: entry.shasum,
      }),
      name: entry.name,
      version: entry.version,
      scope: packageScope(entry.name),
      manifest,
      metadataSha256,
      receiptEntry: entry,
    };
    nodes.push(node);
    nodesBySurface.set(node.address.packageSurface, node);
  }

  const dependencyEdges = [];
  const defects = [];
  const observations = [];
  for (const node of nodes) {
    for (const relation of DEPENDENCY_RELATIONS) {
      const declared = node.manifest[relation];
      if (declared === null || typeof declared !== "object" || Array.isArray(declared)) continue;
      for (const [depName, pin] of Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))) {
        const scope = packageScope(depName);
        const internal = scope !== null && ownedScopes.has(scope);
        if (!internal) {
          dependencyEdges.push(Object.freeze({
            from: node.address.packageSurface,
            to: depName,
            constraint: pin,
            relation,
            resolution: "external",
          }));
          continue;
        }
        if (isPublishedLocalOnlyProtocol(pin)) {
          defects.push(Object.freeze({
            kind: "local-only-internal-dependency-protocol",
            from: node.address.packageSurface,
            to: packageSurface(depName, pin),
            relation,
            constraint: pin,
          }));
          continue;
        }
        const resolved = await resolvePublishedDependency(depName, pin, source, metadataCache);
        const resolvedSurface = resolved === null ? packageSurface(depName, pin) : packageSurface(resolved.name, resolved.version);
        const target = nodesBySurface.get(resolvedSurface);
        if (target === undefined) {
          if (resolved !== null) {
            observations.push(Object.freeze({
              kind: "available-nonlatest-internal-dependency",
              from: node.address.packageSurface,
              to: resolvedSurface,
              relation,
            }));
            dependencyEdges.push(Object.freeze({
              from: node.address.packageSurface,
              to: resolvedSurface,
              constraint: pin,
              relation,
              resolution: "available-nonlatest-internal-dependency",
            }));
            continue;
          }
          defects.push(Object.freeze({
            kind: "unavailable-internal-dependency",
            from: node.address.packageSurface,
            to: packageSurface(depName, pin),
            relation,
          }));
          continue;
        }
        dependencyEdges.push(Object.freeze({
          from: node.address.packageSurface,
          to: target.address.packageSurface,
          constraint: pin,
          relation,
          resolution: "registry",
        }));
      }
    }
  }

  // Package replacement is history, not dependency. A renamed or consolidated
  // package may identify the exact release it replaces without making either
  // package install the other. Keeping this edge in the registry graph makes
  // duplicate implementations and completed migrations mechanically visible.
  const supersessionEdges = [];
  for (const node of nodes) {
    const declaration = node.manifest.redCupEngineering?.supersedes;
    const declarations = declaration === undefined ? [] : Array.isArray(declaration) ? declaration : [declaration];
    for (const replaced of declarations) {
      if (replaced === null || typeof replaced !== "object" || typeof replaced.package !== "string" || typeof replaced.version !== "string") {
        defects.push(Object.freeze({
          kind: "invalid-supersession-declaration",
          from: node.address.packageSurface,
        }));
        continue;
      }
      const target = packageSurface(replaced.package, replaced.version);
      if (!nodesBySurface.has(target)) {
        const scope = packageScope(replaced.package);
        if (scope !== null && ownedScopes.has(scope)) {
          const published = await publishedVersion(replaced.package, replaced.version, source, metadataCache);
          if (published === null) {
            defects.push(Object.freeze({
              kind: "unavailable-superseded-release",
              from: node.address.packageSurface,
              to: target,
            }));
            continue;
          }
          supersessionEdges.push(Object.freeze({
            from: node.address.packageSurface,
            to: target,
            relation: "supersedes",
            resolution: "available-nonlatest-internal-release",
            ...(typeof replaced.reason === "string" && replaced.reason !== "" ? { reason: replaced.reason } : {}),
          }));
          continue;
        }
        supersessionEdges.push(Object.freeze({
          from: node.address.packageSurface,
          to: target,
          relation: "supersedes",
          resolution: "external",
          ...(typeof replaced.reason === "string" && replaced.reason !== "" ? { reason: replaced.reason } : {}),
        }));
        continue;
      }
      supersessionEdges.push(Object.freeze({
        from: node.address.packageSurface,
        to: target,
        relation: "supersedes",
        resolution: "registry",
        ...(typeof replaced.reason === "string" && replaced.reason !== "" ? { reason: replaced.reason } : {}),
      }));
    }
  }

  return Object.freeze({
    type: GRAPH_TYPE,
    registry: receipt?.registry ?? source.registry,
    receiptSha256,
    scopes: Object.freeze([...ownedScopes].sort()),
    nodes: Object.freeze(nodes.map((node) => Object.freeze({
      address: node.address,
      name: node.name,
      version: node.version,
      scope: node.scope,
      metadataSha256: node.metadataSha256,
    }))),
    tiers: Object.freeze({
      dependency: Object.freeze({ edges: Object.freeze(dependencyEdges) }),
      history: Object.freeze({
        predecessor: receipt?.predecessor ?? null,
        reaction: receipt?.reaction ?? null,
        receiptVersion: receipt === null ? null : receipt.version ?? 1,
        edges: Object.freeze(supersessionEdges),
      }),
      witness: Object.freeze({
        receiptSha256,
        compute: receipt?.compute ?? null,
        artifacts: Object.freeze(nodes.map((node) => Object.freeze({
          packageSurface: node.address.packageSurface,
          artifact: node.receiptEntry.artifact,
          bytes: node.receiptEntry.bytes,
          shasum: node.receiptEntry.shasum,
          integrity: node.receiptEntry.integrity,
        }))),
      }),
    }),
    // Non-failing latest-set convergence observations: the exact version is
    // published, but differs from the single latest release chosen as a node.
    observations: Object.freeze(observations),
    defects: Object.freeze(defects),
  });
}

export function groupRegistryGraphDefects(defects) {
  if (!Array.isArray(defects)) throw new TypeError("registry graph defects must be an array");
  const groups = new Map();
  for (const defect of defects) {
    const key = JSON.stringify([defect.kind, defect.to ?? null, defect.relation ?? null]);
    const group = groups.get(key) ?? {
      kind: defect.kind,
      target: defect.to ?? null,
      relation: defect.relation ?? null,
      count: 0,
      consumers: [],
    };
    group.count += 1;
    if (typeof defect.from === "string") group.consumers.push(defect.from);
    groups.set(key, group);
  }
  return Object.freeze([...groups.values()]
    .map((group) => Object.freeze({
      ...group,
      consumers: Object.freeze([...new Set(group.consumers)].sort()),
    }))
    .sort((left, right) =>
      right.count - left.count
      || String(left.target).localeCompare(String(right.target))
      || String(left.kind).localeCompare(String(right.kind))
      || String(left.relation).localeCompare(String(right.relation))));
}

function dotIdentifier(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderRegistryGraphDot(graph, { tier = "dependency" } = {}) {
  if (graph?.type !== GRAPH_TYPE) throw new TypeError(`one ${GRAPH_TYPE} is required`);
  const lines = [`digraph ${JSON.stringify(`registry-${tier}`)} {`, "  rankdir=LR;"];
  if (tier === "dependency") {
    for (const node of graph.nodes) lines.push(`  ${dotIdentifier(node.address.packageSurface)} [shape=box];`);
    const externals = new Set();
    for (const edge of graph.tiers.dependency.edges) {
      if (edge.resolution === "external") {
        if (!externals.has(edge.to)) {
          externals.add(edge.to);
          lines.push(`  ${dotIdentifier(edge.to)} [shape=box, style=dashed];`);
        }
        lines.push(`  ${dotIdentifier(edge.from)} -> ${dotIdentifier(edge.to)} [style=dashed, label=${dotIdentifier(edge.relation)}];`);
      } else {
        lines.push(`  ${dotIdentifier(edge.from)} -> ${dotIdentifier(edge.to)} [label=${dotIdentifier(edge.relation)}];`);
      }
    }
  } else if (tier === "history") {
    for (const node of graph.nodes) lines.push(`  ${dotIdentifier(node.address.packageSurface)} [shape=box];`);
    for (const edge of graph.tiers.history.edges ?? []) {
      lines.push(`  ${dotIdentifier(edge.from)} -> ${dotIdentifier(edge.to)} [label=${dotIdentifier(edge.relation)}];`);
    }
  } else {
    throw new TypeError(`unknown registry graph tier: ${tier}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
