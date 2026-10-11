# npm cache release recovery service

Audits one or more explicit `package-lock.json` files against an explicit npm
cache directory. It reads the cache through `cacache` using npm's
request-cache key format and verifies each tarball against the lockfile SRI
integrity before considering it recovered. It emits one JSON audit document
and makes no writes unless `--output` is supplied.

```sh
recover-npm-cache-releases --cache /path/to/npm-cache --lock /work/a/package-lock.json --lock /work/b/package-lock.json
recover-npm-cache-releases --cache /path/to/npm-cache --lock /work/package-lock.json --output /srv/recovered-tarballs
```

Verified tarballs are written only with `--output`, as
`<output>/<package-name>/<version>/package.tgz`. Existing paths are never
overwritten. Conflicting evidence for the same name and version across locks
is rejected before the cache is read or any output is written.

## Operation

`recoverNpmCacheReleases` (`src/recover-npm-cache-releases.mjs`) is this
package's single public operation, exposed identically through package
`exports`, `bin`, and the `scripts/recover-npm-cache-releases.mjs` CLI. It
combines evidence from every supplied lock, recovers/verifies against the
cache, optionally materializes verified bytes, and reports a stable,
name/version-sorted audit. It makes no registry or filesystem writes unless
`outputPath` is supplied.

`recoverNpmCacheReleaseTarballs` is the lower-level, single-lock building
block `recoverNpmCacheReleases` composes: given one already-combined
`packageLock`, it reads the cache and reports each release's status
(`recovered`, `missing`, or `integrity-mismatch`) without writing bytes
unless the caller passes `onTarball`.
