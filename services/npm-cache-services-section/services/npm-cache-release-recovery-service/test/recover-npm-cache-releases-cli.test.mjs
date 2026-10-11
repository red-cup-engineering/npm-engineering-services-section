import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/recover-npm-cache-releases.mjs");

test("CLI --help prints usage without requiring --cache or --lock", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: recover-npm-cache-releases/);
});

test("CLI requires --cache and at least one --lock", () => {
  const missingCache = spawnSync(process.execPath, [scriptPath, "--lock", "a.json"], { encoding: "utf8" });
  assert.notEqual(missingCache.status, 0);
  assert.match(missingCache.stderr, /--cache is required/);

  const missingLock = spawnSync(process.execPath, [scriptPath, "--cache", "/cache"], { encoding: "utf8" });
  assert.notEqual(missingLock.status, 0);
  assert.match(missingLock.stderr, /at least one --lock is required/);
});

test("CLI prints the same audit shape as the exported operation for evidence-free locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-cache-release-recovery-cli-"));
  try {
    const lockPath = join(root, "package-lock.json");
    // No `packages` entry here carries a remote `resolved` URL with integrity,
    // so this exercises the full CLI -> src pipeline without needing a real
    // npm cache or the optional `cacache` dependency to be installed.
    await writeFile(lockPath, JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "root", version: "0.0.0" } }
    }));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--cache", join(root, "cache"), "--lock", lockPath],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout);
    assert.equal(audit.type, "NpmCacheReleaseRecoveryAudit");
    assert.deepEqual(audit.locks, [resolve(lockPath)]);
    assert.deepEqual(audit.audit, []);
    assert.deepEqual(audit.written, []);
    assert.equal(audit.outputPath, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
