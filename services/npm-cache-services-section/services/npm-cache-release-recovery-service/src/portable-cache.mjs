import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function exportPortableCache(outputPath, tarballs) {
  const root = resolve(outputPath);
  await mkdir(dirname(root), { recursive: true });
  // Exclusive ownership: never merge into a live cache or overwrite an export.
  await mkdir(root);
  try {
    const { put } = await import('cacache');
    const cache = join(root, '_cacache');
    const entries = [];
    const keys = new Set();
    for (const tarball of tarballs) {
      // Synthesize minimal HTTP response metadata rather than copying possible
      // authorization/cookie headers from a machine-local cache index.
      const integrity = keys.has(tarball.cacheKey) ? tarball.integrity : await put(cache, tarball.cacheKey, tarball.data, {
        integrity: tarball.integrity,
        metadata: {
          time: 0, url: tarball.resolved, reqHeaders: {},
          resHeaders: { 'content-type': 'application/octet-stream' },
          options: { compress: true }
        }
      });
      keys.add(tarball.cacheKey);
      entries.push({ name: tarball.name, version: tarball.version, resolved: tarball.resolved, integrity: String(integrity), cacheKey: tarball.cacheKey });
    }
    const manifest = { type: 'PortableNpmCache', cachePath: '.', cacachePath: '_cacache', indexEntryCount: keys.size, synthesizedIndexEntryCount: keys.size, entries };
    await writeFile(join(root, 'recovery-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { ...manifest, path: root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
