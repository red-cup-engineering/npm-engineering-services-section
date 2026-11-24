import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';

import { sourceFinder } from './recovery-sources.mjs';
import { exportPortableCache } from './portable-cache.mjs';

const CACHE_KEY_PREFIX = 'make-fetch-happen:request-cache:';

export class AmbiguousLockEvidenceError extends Error {
  constructor(name, version, evidence) {
    super(`Conflicting package-lock evidence for ${name}@${version}.`);
    this.name = 'AmbiguousLockEvidenceError';
    this.code = 'ERR_NPM_CACHE_RELEASE_AMBIGUOUS_LOCK_EVIDENCE';
    this.evidence = evidence;
  }
}

export class MissingLockIntegrityError extends Error {
  constructor(lockPath) {
    super(`Remote package-lock entry ${lockPath} has no integrity value.`);
    this.name = 'MissingLockIntegrityError';
    this.code = 'ERR_NPM_CACHE_RELEASE_MISSING_LOCK_INTEGRITY';
    this.lockPath = lockPath;
  }
}

/**
 * Extracts the final installed package name from a package-lock `packages` key.
 * It deliberately ignores parent package names in nested installations.
 */
export function packageNameFromLockPath(lockPath) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(lockPath);
  return match?.[1] ?? null;
}

export function cacheKeyForResolvedTarball(resolved) {
  return `${CACHE_KEY_PREFIX}${resolved}`;
}

export function collectLockedReleases(packageLock) {
  if (!packageLock || typeof packageLock !== 'object' || !packageLock.packages || typeof packageLock.packages !== 'object') {
    throw new TypeError('packageLock.packages must be an object from an npm package-lock file.');
  }

  const releases = new Map();
  for (const [lockPath, entry] of Object.entries(packageLock.packages)) {
    const name = packageNameFromLockPath(lockPath);
    if (!name || !entry || typeof entry !== 'object' || entry.link) continue;
    if (typeof entry.version !== 'string' || typeof entry.resolved !== 'string') continue;
    if (!/^https?:\/\//.test(entry.resolved)) continue;
    if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) throw new MissingLockIntegrityError(lockPath);

    const key = `${name}@${entry.version}`;
    const candidate = {
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      lockPaths: [lockPath]
    };
    const previous = releases.get(key);
    if (!previous) {
      releases.set(key, candidate);
      continue;
    }
    if (previous.resolved !== candidate.resolved || previous.integrity !== candidate.integrity) {
      throw new AmbiguousLockEvidenceError(name, entry.version, [previous, candidate]);
    }
    previous.lockPaths.push(lockPath);
  }

  return [...releases.values()]
    .map((release) => ({ ...release, lockPaths: [...release.lockPaths].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function verifyIntegrity(data, integrity) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new TypeError('Tarball data must be a Buffer or Uint8Array.');
  }
  const candidates = integrityCandidates(integrity);
  for (const match of candidates) {
    const expected = Buffer.from(match[2], 'base64');
    const actual = Buffer.from(createHash(match[1]).update(data).digest('base64'), 'base64');
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

function integrityCandidates(integrity) {
  if (typeof integrity !== 'string') throw new TypeError('npm integrity must be a string');
  const matches = [];
  for (const token of integrity.trim().split(/\s+/)) {
    if (!/^sha(?:1|256|384|512)-/.test(token)) continue;
    const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(token);
    if (!match || Buffer.from(match[2], 'base64').length !== ({ sha1: 20, sha256: 32, sha384: 48, sha512: 64 })[match[1]]) throw new TypeError(`Unsupported or invalid npm integrity value: ${integrity}`);
    matches.push(match);
  }
  if (!matches.length) throw new TypeError(`Unsupported or invalid npm integrity value: ${integrity}`);
  const strength = Math.max(...matches.map((match) => Number(match[1].slice(3))));
  return matches.filter((match) => Number(match[1].slice(3)) === strength);
}

function cacheDirectories(cachePath) {
  // Accept the existing direct cacache API as well as npm's --cache root.
  return [resolve(cachePath), join(resolve(cachePath), '_cacache')];
}

async function readCacheCandidates(cachePath, read) {
  let mismatch;
  for (const path of cacheDirectories(cachePath)) {
    try { return await read(path); } catch (error) {
      if (!['ENOENT', 'EINTEGRITY'].includes(error?.code)) throw error;
      if (error.code === 'EINTEGRITY') mismatch = error;
    }
  }
  throw mismatch ?? Object.assign(new Error('Cache content not found'), { code: 'ENOENT' });
}

async function defaultReadCacheEntry(cachePath, cacheKey) {
  const { get } = await import('cacache');
  return readCacheCandidates(cachePath, (path) => get(path, cacheKey));
}

async function defaultReadCacheContent(cachePath, integrity) {
  const { get } = await import('cacache');
  return readCacheCandidates(cachePath, async (path) => ({ data: await get.byDigest(path, integrity) }));
}

/** Recover exact locked bytes from the index, content SRI, or explicit sources. */
export async function recoverNpmCacheReleaseTarballs({ packageLock, cachePath, readCacheEntry = defaultReadCacheEntry, readCacheContent = defaultReadCacheContent, findTarball, onTarball } = {}) {
  if (typeof cachePath !== 'string' || cachePath.length === 0) throw new TypeError('cachePath must be a non-empty npm cache directory path.');
  if (typeof readCacheEntry !== 'function') throw new TypeError('readCacheEntry must be a function.');
  if (typeof readCacheContent !== 'function') throw new TypeError('readCacheContent must be a function.');
  if (onTarball !== undefined && typeof onTarball !== 'function') throw new TypeError('onTarball must be a function when provided.');
  const releases = collectLockedReleases(packageLock);
  for (const release of releases) integrityCandidates(release.integrity);
  const audit = [];
  for (const release of releases) {
    const cacheKey = cacheKeyForResolvedTarball(release.resolved);
    let recovered, mismatch = false;
    const readers = [
      [() => readCacheEntry(cachePath, cacheKey), { type: 'cache-index' }],
      [() => readCacheContent(cachePath, release.integrity), { type: 'cache-content' }],
      ...(findTarball ? [[() => findTarball(release), null]] : [])
    ];
    for (const [read, recoverySource] of readers) {
      let entry;
      try { entry = await read(); } catch (error) {
        if (!['ENOENT', 'EINTEGRITY'].includes(error?.code)) throw error;
        if (error.code === 'EINTEGRITY') mismatch = true;
        continue;
      }
      if (!entry) continue;
      if (!entry.data || !verifyIntegrity(entry.data, release.integrity)) { mismatch = true; continue; }
      recovered = { ...entry, recoverySource: entry.recoverySource ?? recoverySource };
      break;
    }
    if (!recovered) {
      audit.push({ ...release, cacheKey, status: mismatch ? 'integrity-mismatch' : 'missing' });
      continue;
    }
    if (onTarball) await onTarball({ ...release, cacheKey, data: recovered.data, recoverySource: recovered.recoverySource });
    audit.push({ ...release, cacheKey, status: 'recovered', recoverySource: recovered.recoverySource });
  }
  return audit;
}

// --- multi-lock evidence combination and optional on-disk materialization --
//
// The functions below compose recoverNpmCacheReleaseTarballs into this
// package's single public operation, recoverNpmCacheReleases: combine
// evidence from one or more explicit package-lock files, recover/verify
// against the cache, optionally materialize verified bytes, and report a
// stable audit. They were formerly split across a consuming app; merged
// here because they are not a separable operation from the recovery they
// audit (COMPOSITION: the app's output was always this function's input).

function evidenceConflict(release, candidate) {
  return release.resolved !== candidate.resolved || release.integrity !== candidate.integrity;
}

export function combineLockEvidence(locks) {
  const releases = new Map();
  for (const { path, packageLock } of locks) {
    for (const release of collectLockedReleases(packageLock)) {
      const key = `${release.name}@${release.version}`;
      const candidate = { ...release, sources: [{ path, lockPaths: release.lockPaths }] };
      const previous = releases.get(key);
      if (!previous) {
        releases.set(key, candidate);
        continue;
      }
      if (evidenceConflict(previous, candidate)) {
        throw new AmbiguousLockEvidenceError(release.name, release.version, [previous, candidate]);
      }
      previous.sources.push(...candidate.sources);
    }
  }
  return [...releases.values()]
    .map((release) => ({ ...release, sources: release.sources.sort((left, right) => left.path.localeCompare(right.path)) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function recoveryPackageLock(releases) {
  return {
    lockfileVersion: 3,
    packages: Object.fromEntries(releases.map((release, index) => [
      `node_modules/lock-${index}/node_modules/${release.name}`,
      { version: release.version, resolved: release.resolved, integrity: release.integrity }
    ]))
  };
}

function isContained(root, target) {
  const path = relative(root, target);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

export function canonicalTarballPath(outputPath, { name, version }) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) throw new TypeError(`Unsafe npm package name: ${name}`);
  if (!/^[a-z0-9][a-z0-9._+-]*$/iu.test(version) || version === '.' || version === '..') throw new TypeError(`Unsafe package version: ${version}`);
  const root = resolve(outputPath);
  const target = resolve(root, name, version, 'package.tgz');
  if (!isContained(root, target)) throw new Error('Canonical tarball path escapes the output directory');
  return target;
}

export async function materializeTarball(outputPath, tarball, fs = { lstat, mkdir, realpath, writeFile }) {
  const target = canonicalTarballPath(outputPath, tarball);
  const root = resolve(outputPath);
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  let directory = root;
  for (const component of relative(root, dirname(target)).split(sep)) {
    directory = resolve(directory, component);
    try { await fs.mkdir(directory); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const status = await fs.lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Tarball destination contains a non-directory or symbolic link');
    const realDirectory = await fs.realpath(directory);
    if (!isContained(realRoot, realDirectory)) throw new Error('Tarball destination escapes the output directory');
  }
  await fs.writeFile(target, tarball.data, { flag: 'wx' });
  return target;
}

/**
 * Audits one or more explicit package-lock files (`options.lockPaths`)
 * against an explicit npm cache directory (`options.cachePath`) and, only
 * when `options.outputPath` is supplied, materializes integrity-verified
 * tarballs beneath it as `<outputPath>/<name>/<version>/package.tgz`.
 * Conflicting evidence for the same name/version across locks is rejected
 * before the cache is read or anything is written. This is the package's
 * single public operation: it holds no state between calls.
 */
export async function recoverNpmCacheReleases(options, dependencies = {}) {
  if (!Array.isArray(options?.lockPaths) || options.lockPaths.length === 0 || options.lockPaths.some((path) => typeof path !== 'string' || !path)) throw new TypeError('at least one explicit lockPaths entry is required');
  if (typeof options.cachePath !== 'string' || !options.cachePath) throw new TypeError('cachePath must be a non-empty npm cache directory path.');
  for (const key of ['sourcePaths', 'archivePaths']) {
    if (options[key] !== undefined && (!Array.isArray(options[key]) || options[key].some((path) => typeof path !== 'string' || !path))) throw new TypeError(`${key} must contain explicit paths`);
  }
  for (const key of ['outputPath', 'portableCachePath']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) throw new TypeError(`${key} must be a non-empty path`);
  }
  const fs = { readFile, lstat, mkdir, realpath, writeFile, ...dependencies.fs };
  const readLock = dependencies.readLock ?? (async (path) => JSON.parse(await fs.readFile(path, 'utf8')));
  const locks = [];
  for (const path of options.lockPaths) locks.push({ path: resolve(path), packageLock: await readLock(path) });
  const releases = combineLockEvidence(locks);
  if (releases.length === 0) throw new Error('No remote npm releases in supplied locks; no npm dependency closure was established');
  for (const release of releases) integrityCandidates(release.integrity);
  if (options.portableCachePath) {
    const byUrl = new Map();
    for (const release of releases) {
      const previous = byUrl.get(release.resolved);
      if (previous && previous.integrity !== release.integrity) throw new Error(`Conflicting integrity evidence for portable cache URL: ${release.resolved}`);
      byUrl.set(release.resolved, release);
    }
  }
  const findTarball = sourceFinder({ sourcePaths: options.sourcePaths ?? [], archivePaths: options.archivePaths ?? [], releases, verifyIntegrity });
  const tarballs = [];
  const written = [];
  const audit = await (dependencies.recover ?? recoverNpmCacheReleaseTarballs)({
    packageLock: recoveryPackageLock(releases),
    cachePath: options.cachePath,
    readCacheEntry: dependencies.readCacheEntry,
    readCacheContent: dependencies.readCacheContent,
    findTarball,
    onTarball: options.outputPath || options.portableCachePath ? async (tarball) => {
      if (options.portableCachePath) tarballs.push(tarball);
      if (options.outputPath) {
        const path = await materializeTarball(options.outputPath, tarball, fs);
        written.push(path);
      }
    } : undefined
  });
  const complete = audit.length === releases.length && audit.every((entry) => entry.status === 'recovered');
  if (options.portableCachePath && complete && tarballs.length !== releases.length) throw new Error('Recovery did not deliver every verified tarball for export');
  const portableCache = options.portableCachePath && complete ? await exportPortableCache(options.portableCachePath, tarballs) : null;
  const evidence = new Map(releases.map((release) => [`${release.name}@${release.version}`, release.sources]));
  return {
    type: 'NpmCacheReleaseRecoveryAudit',
    complete,
    portableCache,
    cachePath: options.cachePath,
    locks: locks.map(({ path }) => path),
    outputPath: options.outputPath ? resolve(options.outputPath) : null,
    audit: audit.map((entry) => ({ ...entry, sources: evidence.get(`${entry.name}@${entry.version}`) })),
    written
  };
}
