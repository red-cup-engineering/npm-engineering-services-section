import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, put, rm as cacheRm } from 'cacache';
import test from 'node:test';
import { cacheKeyForResolvedTarball, recoverNpmCacheReleases, verifyIntegrity } from '../src/recover-npm-cache-releases.mjs';

const bytes = Buffer.from('source bytes locked by the consumer');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const url = 'https://registry.invalid/a/-/a-1.0.0.tgz';
function lock(version = '1.0.0', resolved = url, sri = integrity) {
  return { lockfileVersion: 3, packages: { 'node_modules/a': { version, resolved, integrity: sri } } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'portable-npm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = join(root, 'source-cache');
  const lockPath = join(root, 'package-lock.json');
  await writeFile(lockPath, JSON.stringify(lock()));
  return { root, cachePath, lockPaths: [lockPath] };
}

test('recovers content by locked SRI with no request index from both cache layouts', async (t) => {
  const f = await fixture(t);
  const content = join(f.cachePath, '_cacache');
  await put(content, 'unrelated-key', bytes);
  await cacheRm.entry(content, 'unrelated-key');
  for (const cachePath of [f.cachePath, content]) {
    const result = await recoverNpmCacheReleases({ ...f, cachePath });
    assert.equal(result.complete, true);
    assert.equal(result.audit[0].recoverySource.type, 'cache-content');
    assert.equal(result.portableCache, null);
  }
});

test('repairs corrupt URL evidence from an explicit storage source, without mutating source cache', async (t) => {
  const f = await fixture(t);
  const key = cacheKeyForResolvedTarball(url);
  await put(f.cachePath, key, Buffer.from('wrong bytes'));
  const storage = join(f.root, 'storage');
  await mkdir(storage);
  await writeFile(join(storage, 'untrusted-name.bin'), bytes);
  const result = await recoverNpmCacheReleases({ ...f, sourcePaths: [storage], portableCachePath: join(f.root, 'export') });
  assert.equal(result.complete, true);
  assert.equal(result.audit[0].recoverySource.type, 'file');
  assert.deepEqual((await get(f.cachePath, key)).data, Buffer.from('wrong bytes'));
  const exported = await get(join(f.root, 'export', '_cacache'), key);
  assert.deepEqual(exported.data, bytes);
  assert.equal(exported.metadata.url, url);
  assert.deepEqual(exported.metadata.reqHeaders, {});
});

test('recovers archive members by bytes, never by names, without filesystem extraction', async (t) => {
  const f = await fixture(t);
  const storage = join(f.root, 'storage');
  await mkdir(storage);
  await writeFile(join(storage, '--arbitrary.tgz'), bytes);
  await writeFile(join(storage, 'wrong.tgz'), 'not the locked bytes');
  const archive = join(f.root, 'storage.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', storage, '--', '--arbitrary.tgz', 'wrong.tgz']);
  await rm(storage, { recursive: true });
  const result = await recoverNpmCacheReleases({ ...f, archivePaths: [archive] });
  assert.equal(result.complete, true);
  assert.equal(result.audit[0].recoverySource.member, '--arbitrary.tgz');
  await assert.rejects(readFile(join(storage, '--arbitrary.tgz')), { code: 'ENOENT' });
});

test('refuses unreadable archives and source symlinks rather than claiming recovery', async (t) => {
  const f = await fixture(t);
  const bad = join(f.root, 'bad.tar');
  await writeFile(bad, 'not an archive');
  await assert.rejects(recoverNpmCacheReleases({ ...f, archivePaths: [bad] }));
  const link = join(f.root, 'link');
  await symlink(f.lockPaths[0], link);
  await assert.rejects(recoverNpmCacheReleases({ ...f, sourcePaths: [link] }), /symbolic link/);
});

test('incomplete closure refuses portable export and existing destinations are never overwritten', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'output');
  const missing = await recoverNpmCacheReleases({ ...f, portableCachePath: output });
  assert.equal(missing.complete, false);
  assert.equal(missing.portableCache, null);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
  await put(f.cachePath, cacheKeyForResolvedTarball(url), bytes);
  await mkdir(output);
  await writeFile(join(output, 'keep'), 'untouched');
  await assert.rejects(recoverNpmCacheReleases({ ...f, portableCachePath: output }), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'untouched');
});

test('keeps multiple versions of the same package across supplied locks', async (t) => {
  const f = await fixture(t);
  const second = join(f.root, 'second-lock.json');
  const url2 = 'https://registry.invalid/a/-/a-2.0.0.tgz';
  await writeFile(second, JSON.stringify(lock('2.0.0', url2)));
  await put(f.cachePath, cacheKeyForResolvedTarball(url), bytes);
  const result = await recoverNpmCacheReleases({ ...f, lockPaths: [...f.lockPaths, second], portableCachePath: join(f.root, 'output') });
  assert.deepEqual(result.audit.map((entry) => entry.version), ['1.0.0', '2.0.0']);
  assert.equal(result.portableCache.indexEntryCount, 2);
  assert.deepEqual((await get(join(f.root, 'output', '_cacache'), cacheKeyForResolvedTarball(url2))).data, bytes);
});

test('refuses absent locks, PNPM-only evidence, and empty npm locks before cache reads or writes', async (t) => {
  const f = await fixture(t);
  for (const lockPaths of [[], undefined]) await assert.rejects(recoverNpmCacheReleases({ ...f, lockPaths }), /explicit lockPaths/);
  await writeFile(f.lockPaths[0], JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await assert.rejects(recoverNpmCacheReleases(f), /No remote npm releases/);
  await writeFile(f.lockPaths[0], 'lockfileVersion: 9.0\n');
  await assert.rejects(recoverNpmCacheReleases(f), SyntaxError);
});

test('validates strongest SRI before reading sources', async (t) => {
  const f = await fixture(t);
  const weak = `sha1-${createHash('sha1').update(bytes).digest('base64')}`;
  const wrong = `sha512-${createHash('sha512').update('wrong').digest('base64')}`;
  assert.equal(verifyIntegrity(bytes, `${weak} ${wrong}`), false);
  assert.throws(() => verifyIntegrity(bytes, `${weak} sha512-invalid`), /invalid npm integrity/);
  await writeFile(f.lockPaths[0], JSON.stringify(lock('1.0.0', url, 'sha512-invalid')));
  let read = false;
  await assert.rejects(recoverNpmCacheReleases(f, { readCacheEntry: async () => { read = true; } }), /invalid npm integrity/);
  assert.equal(read, false);
});

test('refuses a portable request key with conflicting locked content before writing', async (t) => {
  const f = await fixture(t);
  const second = join(f.root, 'second.json');
  const otherIntegrity = `sha512-${createHash('sha512').update('other').digest('base64')}`;
  await writeFile(second, JSON.stringify(lock('2.0.0', url, otherIntegrity)));
  let read = false;
  await assert.rejects(recoverNpmCacheReleases({ ...f, lockPaths: [...f.lockPaths, second], portableCachePath: join(f.root, 'output') }, { readCacheEntry: async () => { read = true; } }), /Conflicting integrity evidence/);
  assert.equal(read, false);
  await assert.rejects(readdir(join(f.root, 'output')), { code: 'ENOENT' });
});

test('portable export synthesizes HTTP records instead of copying cache authorization headers', async (t) => {
  const f = await fixture(t);
  const key = cacheKeyForResolvedTarball(url);
  await put(f.cachePath, key, bytes, { metadata: { reqHeaders: { authorization: 'test-only-marker' }, resHeaders: { 'set-cookie': 'test-cookie' } } });
  const output = join(f.root, 'output');
  const result = await recoverNpmCacheReleases({ ...f, portableCachePath: output });
  assert.equal(result.audit[0].recoverySource.type, 'cache-index');
  const entry = await get(join(output, '_cacache'), key);
  assert.equal(JSON.stringify(entry.metadata).includes('test-only-marker'), false);
  assert.equal(JSON.stringify(entry.metadata).includes('test-cookie'), false);
  assert.equal(result.portableCache.synthesizedIndexEntryCount, 1);
});
