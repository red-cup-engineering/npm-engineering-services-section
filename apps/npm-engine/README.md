# npm-engine

Plan and apply npm package normalization for explicitly selected source manifests.
The planner uses npm's effective registry settings for each package, including
project scope settings. It records the addresses of the source inputs and
registry metadata alongside the proposed manifest and import edits.

```sh
npm-engine normalize ROOT package.json --owner red-cup-engineering --output /tmp/npm-normalization.json
npm-engine apply-normalization ROOT /tmp/npm-normalization.json
```

Pass multiple package paths relative to `ROOT` to normalize them together.
Section-owned source can use the existing owner projection. Each relative
import crossing selected packages requires a published provider export.
The plan selects versions from registry metadata. Artifact installation and
verification are separate steps.

Apply checks the selected root, registry bindings and exact original file bytes
before replacing files. If a replacement fails, the engine restores earlier
replacements that still carry its installed bytes and reports any unresolved
restoration.

The library exposes `planNpmPackageNormalization` and
`applyNpmPackageNormalization` at
`@red-cup-engineering/npm-engine/package-normalization`.
