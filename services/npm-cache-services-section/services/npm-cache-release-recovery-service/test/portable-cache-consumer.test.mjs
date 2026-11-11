import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { put, rm as cacheRm, get } from 'cacache';
import test from 'node:test';
import { cacheKeyForResolvedTarball } from '../src/recover-npm-cache-releases.mjs';

const script = resolve('scripts/recover-npm-cache-releases.mjs');
function run(command, args, cwd, cache) {
  const env = { ...process.env, NPM_CONFIG_CACHE: cache, NPM_CONFIG_USERCONFIG: join(cwd, 'empty.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(cwd, 'empty-global.npmrc') };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

test('CLI portable export is received by a clean native offline npm ci, including content-only sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'portable-npm-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  const consumer = join(root, 'consumer');
  await mkdir(packageDir); await mkdir(consumer);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'portable-recovery-fixture', version: '1.0.0', main: 'index.js' }));
  await writeFile(join(packageDir, 'index.js'), 'module.exports = "received exact locked package";\n');
  const packed = run('npm', ['pack', '--ignore-scripts', '--json'], packageDir, join(root, 'pack-cache'));
  assert.equal(packed.status, 0, packed.stderr);
  const data = await readFile(join(packageDir, JSON.parse(packed.stdout)[0].filename));
  const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  const resolved = 'https://registry.invalid/portable-recovery-fixture/-/portable-recovery-fixture-1.0.0.tgz';
  const pkg = { name: 'offline-consumer', version: '1.0.0', dependencies: { 'portable-recovery-fixture': '1.0.0' } };
  await writeFile(join(consumer, 'package.json'), JSON.stringify(pkg));
  const lock = { ...pkg, lockfileVersion: 3, requires: true, packages: { '': pkg, 'node_modules/portable-recovery-fixture': { version: '1.0.0', resolved, integrity } } };
  const lockPath = join(consumer, 'package-lock.json');
  await writeFile(lockPath, JSON.stringify(lock));
  const missing = run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, join(root, 'empty-cache'));
  assert.notEqual(missing.status, 0, 'The empty-cache negative control must fail');
  assert.match(missing.stderr, /ENOTCACHED/);
  const source = join(root, 'source', '_cacache');
  await put(source, 'no-http-index', data);
  await cacheRm.entry(source, 'no-http-index');
  const output = join(root, 'export');
  const exported = run(process.execPath, [script, '--cache', source, '--lock', lockPath, '--export-cache', output], consumer, join(root, 'unused-cache'));
  assert.equal(exported.status, 0, exported.stderr);
  const audit = JSON.parse(exported.stdout);
  assert.equal(audit.complete, true);
  assert.equal(audit.audit[0].recoverySource.type, 'cache-content');
  assert.equal(audit.portableCache.indexEntryCount, 1);
  assert.deepEqual((await get(join(output, '_cacache'), cacheKeyForResolvedTarball(resolved))).data, data);
  // Destroy both upstream copies so the portable cache is the sole receiver.
  await rm(join(root, 'source'), { recursive: true });
  await rm(packageDir, { recursive: true });
  const installed = run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer, output);
  assert.equal(installed.status, 0, installed.stderr);
  const called = run(process.execPath, ['-e', 'console.log(require("portable-recovery-fixture"))'], consumer, output);
  assert.equal(called.status, 0, called.stderr);
  assert.equal(called.stdout.trim(), 'received exact locked package');
});

test('CLI reports missing locked bytes with nonzero status and no export', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'portable-npm-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, 'package-lock.json');
  const integrity = `sha512-${createHash('sha512').update('missing').digest('base64')}`;
  await writeFile(lockPath, JSON.stringify({ packages: { 'node_modules/a': { version: '1', resolved: 'https://registry.invalid/a.tgz', integrity } } }));
  const result = run(process.execPath, [script, '--cache', join(root, 'empty'), '--lock', lockPath, '--export-cache', join(root, 'output')], root, join(root, 'unused'));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false);
  await assert.rejects(readFile(join(root, 'output', 'recovery-manifest.json')), { code: 'ENOENT' });
});
