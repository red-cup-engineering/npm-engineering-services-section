# Node runtime container image context materialization service

This service maps a completely verified `NodeRuntimeReleaseCatalogReceipt` to
one new, credential-free container build context. A declarative layout policy
maps every catalog entry identity to one relative context mount. Static files
or directories may be added explicitly; they never overlay a runtime release
or one another.

The service copies no workspace and runs no package manager. It invokes the
Node runtime release materialization owner again, requires its fresh catalog
observation to equal the supplied observation, and recomputes every mounted
`app/` artifact identity after copying. Thus an admitted release cannot be
changed by a customer-specific context adapter.

The resulting `NodeRuntimeContainerImageContextReceipt` binds the runtime
catalog, exact verification observation, normalized layout policy, each
mounted artifact, each static carrier, and every final regular file's relative
path, bytes, SHA-256 digest, and permission mode. Directory metadata is not an
identity input. Its receipt digest and regular-file tree are reproducible
across output paths.
Cloud providers may subsequently admit this context and form their own build
manifest; this package contains no cloud API, registry, credential, image, or
deployment policy.

```json
{
  "type": "NodeRuntimeContainerImageLayoutPolicy",
  "version": 1,
  "entries": [
    { "id": "worker", "mount": "services/worker" }
  ]
}
```

Static carrier declarations contain a relative destination `path` and exactly
one of `sourcePath`, `utf8`, or `base64`. A `sourcePath` may name one regular
file or directory tree. Symbolic links, special files, traversal, overlapping
destinations, credential-shaped filenames, and secret material are refused.
Every file is opened without following its final path component, measured once
through that descriptor, and copied from those admitted bytes. Secret scanning
covers the complete byte carrier regardless of file size or embedded NULs.

The library accepts the release verification owner explicitly. The packaged
CLI supplies `@red-cup-engineering/node-runtime-release-materialization-service`:

```bash
materialize-node-runtime-container-image-context \
  --catalog-directory /admission/catalogs/DIGEST \
  --catalog-receipt /admission/runtime-release-catalog.json \
  --verification-observation /admission/catalog-verification.json \
  --layout-policy /admission/layout.json \
  --static-carriers /admission/static-carriers.json \
  --output /tmp/new-context
```
