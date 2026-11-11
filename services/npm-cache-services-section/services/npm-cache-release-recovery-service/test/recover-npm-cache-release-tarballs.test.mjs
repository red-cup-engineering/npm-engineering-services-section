import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  AmbiguousLockEvidenceError,
  collectLockedReleases,
  MissingLockIntegrityError,
  recoverNpmCacheReleaseTarballs
} from '../src/recover-npm-cache-releases.mjs';

const data = Buffer.from('a cached npm tarball');
const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;

function lock(packages) {
  return { lockfileVersion: 3, packages };
}

test('uses the final node_modules segment for nested scoped packages and deduplicates exact releases', () => {
  assert.deepEqual(collectLockedReleases(lock({
    'node_modules/outer/node_modules/@scope/package': { version: '2.0.0', resolved: 'https://registry.example/@scope/package/-/package-2.0.0.tgz', integrity },
    'node_modules/@scope/package': { version: '2.0.0', resolved: 'https://registry.example/@scope/package/-/package-2.0.0.tgz', integrity },
    'node_modules/outer/node_modules/plain': { version: '1.0.0', resolved: 'https://registry.example/plain/-/plain-1.0.0.tgz', integrity }
  })), [
    { name: '@scope/package', version: '2.0.0', resolved: 'https://registry.example/@scope/package/-/package-2.0.0.tgz', integrity, lockPaths: ['node_modules/@scope/package', 'node_modules/outer/node_modules/@scope/package'] },
    { name: 'plain', version: '1.0.0', resolved: 'https://registry.example/plain/-/plain-1.0.0.tgz', integrity, lockPaths: ['node_modules/outer/node_modules/plain'] }
  ]);
});

test('rejects conflicting lock evidence for an exact name and version', () => {
  assert.throws(() => collectLockedReleases(lock({
    'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a-1.tgz', integrity },
    'node_modules/parent/node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a-other.tgz', integrity }
  })), AmbiguousLockEvidenceError);
});

test('rejects remote lock evidence without integrity rather than recovering unverifiable bytes', () => {
  assert.throws(() => collectLockedReleases(lock({
    'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a-1.tgz' }
  })), MissingLockIntegrityError);
});

test('reports missing cache entries deterministically without writing a tarball', async () => {
  const audit = await recoverNpmCacheReleaseTarballs({
    packageLock: lock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a-1.tgz', integrity } }),
    cachePath: '/cache',
    readCacheEntry: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }
  });
  assert.deepEqual(audit.map(({ name, status }) => ({ name, status })), [{ name: 'a', status: 'missing' }]);
});

test('reports integrity mismatches and only emits verified tarballs to an explicit callback', async () => {
  const emitted = [];
  const packageLock = lock({
    'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example/a-1.tgz', integrity },
    'node_modules/b': { version: '1.0.0', resolved: 'https://registry.example/b-1.tgz', integrity }
  });
  const audit = await recoverNpmCacheReleaseTarballs({
    packageLock,
    cachePath: '/cache',
    readCacheEntry: async (_cachePath, key) => ({ data: key.includes('/a-1.tgz') ? data : Buffer.from('different bytes') }),
    onTarball: async (tarball) => emitted.push(`${tarball.name}@${tarball.version}`)
  });
  assert.deepEqual(audit.map(({ name, status }) => ({ name, status })), [
    { name: 'a', status: 'recovered' },
    { name: 'b', status: 'integrity-mismatch' }
  ]);
  assert.deepEqual(emitted, ['a@1.0.0']);
});
