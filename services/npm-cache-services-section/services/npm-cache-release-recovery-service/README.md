# npm cache release recovery service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Audits one or more explicit `package-lock.json` files against an explicit npm
cache directory. It reads the cache through `cacache` using npm's
request-cache key format and verifies each tarball against the lockfile SRI
integrity before considering it recovered. It emits one JSON audit document
and makes no writes unless `--output` or `--export-cache` is supplied.

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
name/version-sorted audit. It makes no registry writes and no filesystem writes unless
`outputPath` or `portableCachePath` is supplied.

`recoverNpmCacheReleaseTarballs` is the lower-level, single-lock building
block `recoverNpmCacheReleases` composes: given one already-combined
`packageLock`, it reads the cache and reports each release's status
(`recovered`, `missing`, or `integrity-mismatch`) without writing bytes
unless the caller passes `onTarball`.

## Recover and export a portable npm cache

```sh
recover-npm-cache-releases --cache /work/npm-cache \
  --lock /work/application/package-lock.json \
  --source /work/extracted-registry-storage \
  --archive /work/registry-backup.tar.gz \
  --export-cache /work/new-portable-cache
npm ci --offline --ignore-scripts --no-audit --no-fund --cache /work/new-portable-cache
```

`--cache` accepts an npm cache root or the direct `_cacache` directory.
Recovery first tries the exact request key, then the lock's content integrity,
so lost or corrupt HTTP index records do not hide intact content. `--source`
accepts explicit files or directories of stored bytes. `--archive` accepts
`.tar`, `.tar.gz`/`.tgz`, or `.tar.zst` backups containing package `.tgz` or
`.tar.gz` members. Both options are repeatable. Archives require `tar`, and
Zstandard archives require its `zstd` support. Members are read to stdout,
never extracted onto disk; filenames do not establish package identity.
Directory walks skip child symlinks and reject symbolic-link roots. Archives
are bounded to 512 MiB per listing or selected member.

Every recovered byte sequence must match the strongest supported algorithm in
the original lock SRI. Conflicting exact releases are refused before reading
cache content. Different versions of the same package remain distinct across
all supplied locks. The audit records source kind/path/member as applicable.
Absent locks, PNPM input and npm locks without any remote releases cannot
claim npm closure. `complete` is true only when every selected release was
recovered; the CLI exits nonzero on incomplete closure or invalid evidence.
Only HTTP(S) registry releases are selected; local links, file dependencies and
Git dependencies require their own receiving evidence. This service does not interpret PNPM stores or change a consumer's package
manager.

`--export-cache` corresponds to API `portableCachePath`; source and archive
options are `sourcePaths` and `archivePaths`. Export only occurs for a complete
closure into a newly created, exclusive destination. Existing directories
(including live caches) are never modified. Failed exports remove only their
new output directory. The result contains `portableCache` and the destination
contains `recovery-manifest.json`, `_cacache/content-v2`, and
`_cacache/index-v5`. Pass the destination itself to npm's `--cache`, not its
`_cacache` child. The existing `--output`/`outputPath` option remains an
independent per-tarball export and may contain a verified subset when closure
is incomplete.

Portable request records are generated through the locked `cacache` dependency
with minimal HTTP response metadata. They are synthesized even when a source
index exists, avoiding accidental export of machine-local authorization or
cookie headers. Conflicting integrities for a shared request URL are refused
before export. Content objects retain integrity addressing; no registry calls
or source-cache mutations occur during recovery/export.

This receives the generic npm export behavior formerly embedded in
`causeway-services/public-koios-news-media-services-section` at
`d72eff7898e3d4070486313d6297145ff40ea722`, without restoring its application
lock discovery or assuming current Koios still uses npm.

## Qualification

Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and
`npm run test:consumer`. The consumer test uses actual `cacache`, an empty-cache
negative control, and a fresh native `npm ci --offline` after destroying the
source tarball/cache, then calls the installed package. Tests require npm and
tar in addition to the declared Node version. Source tests and native offline
receiving do not establish registry publication or downstream installation.

## Acceptance

Run `npm test` for the source suite. See the [runnable consumer example](examples/quickstart.test.mjs).
