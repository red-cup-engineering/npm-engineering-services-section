import { access, copyFile, link, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".archive",
  ".git",
  ".tmp",
  "cache",
  "data",
  "node_modules",
  "test",
  "tests",
]);

const EXCLUDED_PATH_SEGMENTS = [
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function validateProjectionPaths(sourceDirectory, targetDirectory) {
  if (typeof sourceDirectory !== "string" || sourceDirectory.length === 0) throw new TypeError("sourceDirectory is required");
  if (typeof targetDirectory !== "string" || targetDirectory.length === 0) throw new TypeError("targetDirectory is required");
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error("carrier projection source and target must not overlap");
  }
  return { source, target };
}

/**
 * Copy the source files that are eligible to enter one npm package carrier.
 *
 * The projection is intentionally conservative: repository and instance
 * territories are excluded, nested package roots are not absorbed, and a
 * symbolic link is refused rather than copied or followed. A carrier must be
 * a self-contained tree; preserving a link could point npm at data outside
 * the reviewed source territory when the artifact is packed elsewhere.
 */
export async function projectNpmCarrier({ sourceDirectory, targetDirectory, manifest, rewriteManifest = false } = {}) {
  const { source, target } = validateProjectionPaths(sourceDirectory, targetDirectory);
  const sourceStatus = await lstat(source);
  if (!sourceStatus.isDirectory()) throw new TypeError("carrier projection sourceDirectory must be a directory");
  if (await exists(target)) {
    const targetStatus = await lstat(target);
    if (targetStatus.isSymbolicLink()) throw new Error("carrier projection targetDirectory must not be a symbolic link");
    if (!targetStatus.isDirectory()) throw new TypeError("carrier projection targetDirectory must be a directory");
  }
  if (rewriteManifest && (!manifest || typeof manifest !== "object" || Array.isArray(manifest))) {
    throw new TypeError("manifest must be an object when rewriteManifest is true");
  }

  async function projectDirectory(from, to, root = false, relativePath = "") {
    await mkdir(to, { recursive: true });
    const entries = await readdir(from, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const entryRelative = `${relativePath}/${entry.name}`;
      const framed = `${entryRelative}/`;
      if (EXCLUDED_PATH_SEGMENTS.some((segment) => framed.includes(segment))) continue;
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (root && rewriteManifest && entry.name === "package.json") continue;
      if (entry.isSymbolicLink()) throw new Error(`carrier projection refused symbolic link: ${entryRelative}`);
      if (entry.isDirectory()) {
        if (!root && await exists(join(sourcePath, "package.json"))) continue;
        await projectDirectory(sourcePath, targetPath, false, entryRelative);
      } else if (entry.isFile()) {
        try {
          await link(sourcePath, targetPath);
        } catch (error) {
          if (error?.code !== "EXDEV") throw error;
          await copyFile(sourcePath, targetPath);
        }
      } else {
        throw new Error(`carrier projection refused non-file entry: ${entryRelative}`);
      }
    }
  }

  await projectDirectory(source, target, true);
  if (rewriteManifest) await writeFile(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export const carrierProjectionExclusions = Object.freeze({
  directoryNames: Object.freeze([...EXCLUDED_DIRECTORY_NAMES].sort()),
  pathSegments: Object.freeze([...EXCLUDED_PATH_SEGMENTS]),
  nestedPackageTerritories: true,
  symbolicLinks: "refused",
});
