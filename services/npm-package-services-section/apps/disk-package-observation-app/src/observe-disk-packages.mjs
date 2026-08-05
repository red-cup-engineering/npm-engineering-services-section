import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { walkPosixPaths } from "@red-cup-engineering/path-walking-service";
import { sliceFilesByType } from "@red-cup-engineering/file-type-slicing-service";

const OBSERVATION_TYPE = "DiskPackageObservation";

function isManifestPath(path) {
  return path === "package.json" || path.endsWith("/package.json");
}

// Composition over the two file-observation actuators: walk a machine path,
// slice the walk by type, and read every package.json into a package entry.
// A manifest that cannot be parsed, or that lacks a name or version, is a
// defect finding, never a silent skip.
export async function observeDiskPackages({ root, excludes = [] } = {}) {
  const walk = await walkPosixPaths({ root, excludes });
  const slice = sliceFilesByType({ files: walk.files });

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
    slices: slice.slices,
  });
}
