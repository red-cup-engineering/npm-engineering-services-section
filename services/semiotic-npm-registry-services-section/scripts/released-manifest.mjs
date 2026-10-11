const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const LOCAL_DEPENDENCY = /^(?:workspace:|file:|link:)/u;

function invalidReleasePlan(message) {
  return new Error(`local dependency requires a complete coordinated releasePlan: ${message}`);
}

function coordinatedBindings(manifest, localDependencies) {
  const plan = manifest.releasePlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw invalidReleasePlan("releasePlan is required");
  if (plan.kind !== "coordinated") throw invalidReleasePlan("kind must be coordinated");
  if (typeof plan.id !== "string" || !plan.id.trim()) throw invalidReleasePlan("id must be a non-empty string");
  if (!Array.isArray(plan.packages) || plan.packages.length < 2 || plan.packages.some((name) => typeof name !== "string" || !name)) {
    throw invalidReleasePlan("packages must name every participating package");
  }
  const packageNames = new Set(plan.packages);
  if (packageNames.size !== plan.packages.length) throw invalidReleasePlan("packages must not repeat a package");
  if (!packageNames.has(manifest.name)) throw invalidReleasePlan(`packages must include consumer ${manifest.name}`);
  for (const provider of localDependencies) {
    if (!packageNames.has(provider)) throw invalidReleasePlan(`packages must include provider ${provider}`);
  }

  const bindings = plan.dependencyBindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw invalidReleasePlan("dependencyBindings is required");
  const bindingNames = Object.keys(bindings);
  if (bindingNames.length !== localDependencies.size || bindingNames.some((name) => !localDependencies.has(name))) {
    throw invalidReleasePlan("dependencyBindings must contain exactly the local dependency names");
  }
  for (const [provider, version] of Object.entries(bindings)) {
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) throw invalidReleasePlan(`dependencyBindings.${provider} must be an exact version`);
  }
  return bindings;
}

/**
 * Create the manifest that is allowed to enter a published npm artifact.
 *
 * Normal npm dependency specifiers are retained verbatim. workspace:, file:,
 * and link: specifiers are never resolved from the checkout or registry: they
 * require an explicit exact binding in one coordinated release plan instead.
 */
export function releasedManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("manifest must be an object");
  const localDependencies = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [provider, requested] of Object.entries(manifest[field] ?? {})) {
      if (typeof requested === "string" && LOCAL_DEPENDENCY.test(requested)) localDependencies.add(provider);
    }
  }

  const bindings = localDependencies.size === 0 ? null : coordinatedBindings(manifest, localDependencies);
  let release = manifest;
  for (const field of ["x-semiotic-voxel", "x-agentic-metro-enterprise"]) {
    if (field in manifest) {
      if (release === manifest) release = structuredClone(manifest);
      delete release[field];
    }
  }
  if (bindings !== null) {
    if (release === manifest) release = structuredClone(manifest);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [provider, requested] of Object.entries(manifest[field] ?? {})) {
        if (typeof requested === "string" && LOCAL_DEPENDENCY.test(requested)) release[field][provider] = bindings[provider];
      }
    }
  }
  return { manifest: release, rewrite: release !== manifest };
}
