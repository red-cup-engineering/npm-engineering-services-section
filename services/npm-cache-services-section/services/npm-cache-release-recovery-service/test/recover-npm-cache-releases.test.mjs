import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  canonicalTarballPath,
  combineLockEvidence,
  materializeTarball,
  recoverNpmCacheReleases
} from "../src/recover-npm-cache-releases.mjs";
import {
  parseRecoveryOptions,
  recoverNpmCacheReleases as recoverNpmCacheReleasesViaScript
} from "../scripts/recover-npm-cache-releases.mjs";

const data = Buffer.from("verified cached tarball");
const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;

function lock(resolved = "https://registry.example/a/-/a-1.0.0.tgz") {
  return { lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0", resolved, integrity } } };
}

test("the scripts/ CLI entrypoint re-exports the same operation as src/, without reimplementing it", () => {
  assert.equal(recoverNpmCacheReleasesViaScript, recoverNpmCacheReleases);
});

test("requires an explicit cache and one or more explicit locks", () => {
  assert.throws(() => parseRecoveryOptions([]), /--cache is required/);
  assert.throws(() => parseRecoveryOptions(["--cache", "/cache"]), /at least one --lock is required/);
  assert.throws(() => parseRecoveryOptions(["--cache"]), /argument missing/);
  assert.deepEqual(parseRecoveryOptions(["--cache", "/cache", "--lock", "a.json", "--lock", "b.json"]), {
    cachePath: "/cache", lockPaths: ["a.json", "b.json"], outputPath: undefined
  });
});

test("combines matching multi-lock evidence and refuses conflicting releases", () => {
  const releases = combineLockEvidence([{ path: "/a/package-lock.json", packageLock: lock() }, { path: "/b/package-lock.json", packageLock: lock() }]);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].sources.map((source) => source.path), ["/a/package-lock.json", "/b/package-lock.json"]);
  assert.throws(() => combineLockEvidence([
    { path: "/a/package-lock.json", packageLock: lock() },
    { path: "/b/package-lock.json", packageLock: lock("https://registry.example/a/-/other.tgz") }
  ]), /Conflicting package-lock evidence/);
});

test("defaults to an audit with no writes and records lock provenance", async () => {
  const writes = [];
  const result = await recoverNpmCacheReleases({ cachePath: "/cache", lockPaths: ["a.json"] }, {
    readLock: async () => lock(),
    recover: async ({ onTarball }) => {
      assert.equal(onTarball, undefined);
      return [{ name: "a", version: "1.0.0", status: "recovered" }];
    },
    fs: { writeFile: async (...args) => writes.push(args) }
  });
  assert.equal(result.outputPath, null);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.audit[0].sources.map((source) => source.path), [resolve("a.json")]);
});

test("materializes only recovered bytes to a canonical exclusive destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-cache-release-recovery-"));
  try {
    const result = await recoverNpmCacheReleases({ cachePath: "/cache", lockPaths: ["a.json"], outputPath: root }, {
      readLock: async () => lock(),
      recover: async ({ onTarball }) => {
        await onTarball({ name: "a", version: "1.0.0", data });
        return [{ name: "a", version: "1.0.0", status: "recovered" }];
      }
    });
    const target = join(root, "a", "1.0.0", "package.tgz");
    assert.deepEqual(await readFile(target), data);
    assert.deepEqual(result.written, [target]);
    await assert.rejects(recoverNpmCacheReleases({ cachePath: "/cache", lockPaths: ["a.json"], outputPath: root }, {
      readLock: async () => lock(),
      recover: async ({ onTarball }) => { await onTarball({ name: "a", version: "1.0.0", data }); return []; }
    }), { code: "EEXIST" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses unsafe canonical package path components", () => {
  assert.throws(() => canonicalTarballPath("/output", { name: "../escape", version: "1.0.0" }), /Unsafe npm package name/);
  assert.throws(() => canonicalTarballPath("/output", { name: "a", version: "../escape" }), /Unsafe package version/);
});

test("refuses a symbolic-link component before creating anything through it", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-cache-release-recovery-link-"));
  try {
    const output = join(root, "output"), outside = join(root, "outside");
    await mkdir(output);
    await mkdir(outside);
    await symlink(outside, join(output, "a"));
    await assert.rejects(
      () => materializeTarball(output, { name: "a", version: "1.0.0", data }),
      /symbolic link/u,
    );
    await assert.rejects(() => readFile(join(outside, "1.0.0", "package.tgz")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
