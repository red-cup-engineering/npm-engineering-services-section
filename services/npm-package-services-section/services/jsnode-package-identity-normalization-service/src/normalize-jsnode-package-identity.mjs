const OWNER = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const PACKAGE_LEAF = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function oneLine(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new TypeError(`${label} must be one non-empty line`);
  }
  return value;
}

function leafOf(packageName) {
  const slash = packageName.startsWith("@") ? packageName.indexOf("/") : -1;
  const source = (slash >= 0 ? packageName.slice(slash + 1) : packageName).toLowerCase();
  const leaf = source
    .replace(/^eo-/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!PACKAGE_LEAF.test(leaf)) throw new TypeError("packageName does not yield a valid npm package leaf");
  return leaf;
}

/**
 * Normalize one admitted JSNode package name under one explicit owner.
 *
 * This is a pure identity morphism. It does not infer ownership, choose a
 * version, inspect a filesystem, classify a voxel, detect set-level
 * collisions, or mutate a package manifest.
 */
export function normalizeJsnodePackageIdentity({ packageName, owner } = {}) {
  const priorName = oneLine(packageName, "packageName");
  const normalizedOwner = oneLine(owner, "owner").replace(/^@/u, "");
  if (!OWNER.test(normalizedOwner)) throw new TypeError("owner must be a valid unscoped npm owner");
  const leaf = leafOf(priorName);
  return Object.freeze({
    type: "JsnodePackageIdentityNormalization",
    priorName,
    owner: normalizedOwner,
    leaf,
    name: `@${normalizedOwner}/${leaf}`,
  });
}
