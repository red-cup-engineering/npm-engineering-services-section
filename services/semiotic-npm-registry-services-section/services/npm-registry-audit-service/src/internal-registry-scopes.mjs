// The registry's own Verdaccio config.yaml `packages:` block is already the
// authority on which scopes it treats as private (access/publish rules keyed
// per scope). A hand-copied second list drifts the moment a scope is added
// there and not updated everywhere that list was pasted. Reading the scope
// set from config.yaml keeps
// there being exactly one place that declares it.
//
// This is a narrow, line-oriented extraction, not a YAML parser: it reads
// only the shape config.yaml actually uses (quoted top-level keys under
// `packages:`, one per line, ended by a change back to lower indentation or
// end of file) and ignores values, anchors, and aliases entirely.
const PACKAGES_SECTION = /^packages:\s*$/u;
const SCOPE_KEY_LINE = /^ {2}'@([^/']+)\/\*'\s*:/u;
const TOP_LEVEL_KEY_LINE = /^\S/u;

/**
 * Extract the sorted, deduplicated list of internal scope names (without the
 * leading `@`) that Verdaccio's config.yaml declares as private packages.
 * Non-scope package entries (bare names, the `**` catch-all) are not scopes
 * and are excluded.
 */
export function deriveInternalRegistryScopes(configYamlText) {
  if (typeof configYamlText !== "string") throw new TypeError("configYamlText must be a string");
  const lines = configYamlText.split(/\r?\n/u);
  const scopes = new Set();
  let inPackagesSection = false;
  for (const line of lines) {
    if (PACKAGES_SECTION.test(line)) {
      inPackagesSection = true;
      continue;
    }
    if (!inPackagesSection) continue;
    if (TOP_LEVEL_KEY_LINE.test(line)) break; // packages: block ended
    const match = SCOPE_KEY_LINE.exec(line);
    if (match) scopes.add(match[1]);
  }
  return Object.freeze([...scopes].sort());
}
