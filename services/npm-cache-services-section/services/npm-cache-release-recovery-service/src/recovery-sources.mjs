import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Archives are read to stdout, never extracted into the filesystem. Package
// identity comes only from the caller's lock integrity, never a member name.
async function archiveRead(path, member) {
  const compression = path.endsWith('.tar.zst') ? ['--zstd'] : /\.(tgz|tar\.gz)$/i.test(path) ? ['-z'] : [];
  const args = [...compression, member === undefined ? '-tf' : '-xOf', path, ...(member === undefined ? [] : ['--', member])];
  const { stdout } = await run('tar', args, { encoding: member === undefined ? 'utf8' : 'buffer', maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

async function* directoryFiles(path) {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`Recovery source must not be a symbolic link: ${path}`);
  if (status.isFile()) { yield path; return; }
  if (!status.isDirectory()) throw new Error(`Recovery source is not a file or directory: ${path}`);
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) yield* directoryFiles(join(path, entry.name));
    else if (entry.isFile()) yield join(path, entry.name);
  }
}

export function sourceFinder({ sourcePaths, archivePaths, releases, verifyIntegrity }) {
  let located;
  return async (release) => {
    if (!located) {
      located = new Map();
      const consider = (data, recoverySource) => {
        for (const entry of releases) {
          if (!located.has(entry.integrity) && verifyIntegrity(data, entry.integrity)) located.set(entry.integrity, { data, recoverySource });
        }
      };
      for (const source of sourcePaths) {
        for await (const path of directoryFiles(resolve(source))) consider(await readFile(path), { type: 'file', path });
      }
      for (const source of archivePaths) {
        const path = resolve(source);
        const status = await lstat(path);
        if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Recovery archive must be a regular file: ${path}`);
        for (const member of (await archiveRead(path)).split('\n').filter((name) => /\.(tgz|tar\.gz)$/i.test(name)).sort()) {
          consider(await archiveRead(path, member), { type: 'archive', path, member });
        }
      }
    }
    return located.get(release.integrity);
  };
}
