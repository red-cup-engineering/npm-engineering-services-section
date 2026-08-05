import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

function registryFace(registryUrl) {
  const url = new URL(registryUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("registry URL must be HTTP(S)");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

// Two sources, one law: a registry is read either from its on-disk directory
// or over the normal npm registry HTTP protocol — GET /{encodeURIComponent(name)}
// for packuments, single percent-encoding, whole packument then versions looked
// up locally (the same protocol install-consumer-dependency-closure speaks).
function diskRegistrySource(registryRoot) {
  const root = resolve(registryRoot);
  return {
    async receiptBytes() {
      return readFile(join(root, "registry-receipt.json"));
    },
    async metadataBytes(name) {
      return readFile(join(root, "metadata", `${encodeURIComponent(name)}.json`));
    },
  };
}

function liveRegistrySource(registryUrl, fetchImplementation) {
  const face = registryFace(registryUrl);
  return {
    async receiptBytes() {
      const response = await fetchImplementation(new URL("registry-receipt.json", face));
      if (!response.ok) throw new Error(`registry face does not publish registry-receipt.json: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async metadataBytes(name) {
      const response = await fetchImplementation(new URL(encodeURIComponent(name), face));
      if (!response.ok) throw new Error(`registry face has no packument for ${name}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

async function readMetadata(name, source, metadataCache) {
  let metadataBytes = metadataCache.get(name);
  if (metadataBytes === undefined) {
    metadataBytes = await source.metadataBytes(name);
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
  return { manifest, metadataSha256: `sha256:${createHash("sha256").update(metadataBytes).digest("hex")}` };
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
  if ((registryRoot === undefined) === (registryUrl === undefined)) {
    throw new TypeError("supply exactly one of registryRoot (directory) or registryUrl (HTTP face)");
  }
  const source = registryUrl === undefined ? diskRegistrySource(registryRoot) : liveRegistrySource(registryUrl, fetchImplementation);
  const metadataCache = new Map();

  let receipt = null;
  let receiptSha256 = null;
  let entries;
  if (packages === undefined) {
    const receiptBytes = await source.receiptBytes();
    receipt = JSON.parse(receiptBytes.toString("utf8"));
    if (receipt?.type !== RECEIPT_TYPE || !Array.isArray(receipt.packages) || !Array.isArray(receipt.scopes)) {
      throw new Error("registry has no recognized build receipt; pass an explicit `packages` list for registries that are not ours");
    }
    receiptSha256 = `sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`;
    entries = [...receipt.packages];
  } else {
    if (!Array.isArray(packages) || packages.length === 0) throw new TypeError("`packages` must be a non-empty array");
    entries = [];
    for (const value of packages.map(requestedPackage)) {
      const { metadata } = await readMetadata(value.name, source, metadataCache);
      const version = value.version ?? metadata["dist-tags"]?.latest;
      if (typeof version !== "string") throw new Error(`registry names no latest version for ${value.name}; request an explicit version`);
      const manifest = metadata.versions?.[version];
      if (manifest === undefined) throw new Error(`registry has no ${value.name}@${version}`);
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
        const target = nodesBySurface.get(packageSurface(depName, pin));
        if (target === undefined) {
          defects.push(Object.freeze({
            kind: "unresolved-internal-dependency",
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
          defects.push(Object.freeze({
            kind: "unresolved-superseded-release",
            from: node.address.packageSurface,
            to: target,
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
    registry: receipt?.registry ?? (registryUrl !== undefined ? registryFace(registryUrl) : resolve(registryRoot)),
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
