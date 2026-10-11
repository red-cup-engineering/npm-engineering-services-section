import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { walkPosixPaths } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";

const OBSERVATION_TYPE = "DiskPackageObservation";

function isManifestPath(path) {
  return path === "package.json" || path.endsWith("/package.json");
}

function extensionOf(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const extension = extname(basename);
  return extension ? extension.slice(1).toLowerCase() : "";
}

// Group an already-observed file list by final, lowercased extension.
function sliceFilesByType({ files }) {
  const slices = {};
  for (const file of files) {
    const extension = extensionOf(file.path);
    const slice = slices[extension] ?? (slices[extension] = { count: 0, bytes: 0, paths: [] });
    slice.count += 1;
    slice.bytes += file.bytes;
    slice.paths.push(file.path);
  }
  for (const extension of Object.keys(slices)) {
    slices[extension].paths.sort((left, right) => left.localeCompare(right));
    slices[extension] = Object.freeze({ ...slices[extension], paths: Object.freeze(slices[extension].paths) });
  }
  return Object.freeze(slices);
}

// Composition over the two file-observation actuators: walk a machine path,
// slice the walk by type, and read every package.json into a package entry.
// A manifest that cannot be parsed, or that lacks a name or version, is a
// defect finding, never a silent skip.
export async function observeDiskPackages({ root, excludes = [] } = {}) {
  const walk = await walkPosixPaths({ root, excludes });
  const slices = sliceFilesByType({ files: walk.files });

  const packages = [];
  const defects = [];
  for (const file of walk.files) {
    if (file.kind !== "file" || !isManifestPath(file.path)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(walk.root, file.path), "utf8"));
    } catch (error) {
      defects.push({ path: file.path, reason: `unparseable manifest: ${error.message}` });
      continue;
    }
    if (typeof manifest.name !== "string" || !manifest.name) {
      defects.push({ path: file.path, reason: "manifest has no name" });
      continue;
    }
    if (typeof manifest.version !== "string" || !manifest.version) {
      defects.push({ path: file.path, reason: "manifest has no version" });
      continue;
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      path: file.path,
      private: manifest.private === true,
    });
  }

  return Object.freeze({
    type: OBSERVATION_TYPE,
    root: walk.root,
    packages: Object.freeze(packages.map((entry) => Object.freeze(entry))),
    defects: Object.freeze(defects.map((entry) => Object.freeze(entry))),
    files: walk.files.length,
    directories: walk.directories,
    excluded: walk.excluded,
    slices,
  });
}
