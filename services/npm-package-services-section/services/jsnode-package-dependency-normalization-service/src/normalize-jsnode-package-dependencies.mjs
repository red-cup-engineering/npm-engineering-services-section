import { dirname, resolve } from "node:path";

const FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

export function normalizeJsnodePackageDependencies({ manifest, manifestPath, root, providersByName = new Map(), providersByDirectory = new Map() } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("manifest is required");
  if (typeof manifestPath !== "string" || typeof root !== "string") throw new TypeError("manifestPath and root are required");
  const result = { ...manifest };
  for (const field of FIELDS) {
    if (!manifest[field]) continue;
    result[field] = Object.fromEntries(Object.entries(manifest[field]).map(([name, value]) => {
      const local = typeof value === "string" ? value.match(/^(?:file:|link:)(.+)$/u) : null;
      const localDirectory = local ? resolve(dirname(resolve(root, manifestPath)), local[1]) : null;
      const provider = (localDirectory && providersByDirectory.get(localDirectory)) || providersByName.get(name);
      return provider ? [provider.name, typeof value === "string" ? provider.version : value] : [name, value];
    }));
  }
  return result;
}
