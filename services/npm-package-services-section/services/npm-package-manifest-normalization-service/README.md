# Normalize an npm package manifest

This library composes the pure npm manifest and version admissions with identity,
engine, package-manager and lifecycle normalization. Its runtime dependencies name
exact registry releases. A caller supplies its explicit identity and exact version;
the normal form preserves other meaningful manifest fields.

The command accepts MANIFEST_PATH IDENTITY_NAME and emits canonical JSON. The
additional stdin commands in scripts retain the individual source operations.

The containing npm-package-services-section owns the shared development tooling
for this source family. Its check-package-syntax and run-package-tests supplier
remains an explicit section-level receiving obligation. The runtime package does
not hire the development actor platform. Native packing needs no generation or
lifecycle execution. Source changes and artifact receiving remain separate.
