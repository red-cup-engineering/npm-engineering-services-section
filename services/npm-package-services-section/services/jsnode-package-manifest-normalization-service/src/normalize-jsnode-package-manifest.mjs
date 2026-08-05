function exactVersion(value) {
  return /^\d+\.\d+\.\d+$/u.test(value ?? "") ? value : "0.1.0";
}

export function normalizeJsnodePackageManifest({ manifest, identity } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("manifest is required");
  if (!identity || typeof identity.name !== "string") throw new TypeError("normalized identity is required");
  const result = { ...manifest, name: identity.name, version: exactVersion(manifest.version) };
  if (result.packageManager?.startsWith("pnpm@")) delete result.packageManager;
  if (result.engines?.pnpm) {
    result.engines = { ...result.engines };
    delete result.engines.pnpm;
    if (Object.keys(result.engines).length === 0) delete result.engines;
  }
  if (result.scripts) result.scripts = Object.fromEntries(Object.entries(result.scripts).map(([name, command]) => [
    name,
    typeof command === "string" ? command.replaceAll("pnpm run ", "npm run ").replaceAll("pnpm test", "npm test") : command,
  ]));
  return result;
}
