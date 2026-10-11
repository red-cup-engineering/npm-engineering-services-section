# npm package install-resolution assay service

This service tests one deliberately narrow claim: npm can resolve and install
selected exact package surfaces through a registry into isolated temporary
consumers. Every invocation passes `--ignore-scripts`; it does **not** prove
imports, runtime behavior, or lifecycle behavior.

It reports typed outcomes for unavailable targets, published local-only
protocols (`workspace:`, `file:`, `link:`), peer/engine resolution, tarball or
integrity failures, timeouts, and other resolution failures. Temporary
consumers are removed after every outcome.

```sh
printf '%s\n' '{"packageSurfaces":["@red-cup-engineering/example@1.0.0"]}' \
  | assay-npm-package-install-resolution
```
