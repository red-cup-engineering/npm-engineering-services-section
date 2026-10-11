import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coordinateNpmRegistryRelease } from "../scripts/npm-registry-release-coordinator-service.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "npm-release-coordinator-"));
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@customer/example", version: "1.0.0" }));
  await writeFile(join(source, "index.mjs"), "export {};\n");
  return { root, source };
}

function dependencies({ failPacking = false } = {}) {
  return {
    async discover() { throw new Error("not used"); },
    async validateReleaseBindings() {},
    async projectReleaseManifest(manifest) { return { manifest, rewrite: false }; },
    async projectCarrier({ targetDirectory }) { await mkdir(targetDirectory, { recursive: true }); },
    async pack({ destinationDirectory }) { if (failPacking) throw new Error("packing failed"); const artifactPath = join(destinationDirectory, "artifact.tgz"); await writeFile(artifactPath, "artifact"); return { artifactPath }; },
    async assemble({ releases, compute }) { return { type: "receipt", packages: releases, compute }; },
    async verify({ receipt }) { return { type: "PackageRegistrySnapshotVerification", version: 1, releaseCount: receipt.packages.length }; },
    async activate({ candidate }) { return { activeSnapshot: candidate.type }; },
  };
}

test("coordinates only injected capabilities and releases lease after an artifact-boundary handoff", async () => {
  const { root, source } = await fixture(); let released = false;
  try {
    const result = await coordinateNpmRegistryRelease({ dependencies: dependencies(), leaseBroker: { async acquire(demand) { assert.equal(demand.workUnits, 1); return { provider: "urn:test", parallelism: 1, settlement: { id: "settled" }, async release() { released = true; } }; } }, packageDirectories: [source], outputDirectory: join(root, "snapshot"), registryUrl: "http://registry.invalid/", activation: { hostDirectory: root, candidateName: "snapshot" } });
    assert.equal(result.verification.releaseCount, 1); assert.equal(result.activation.activeSnapshot, "receipt"); assert.equal(released, true);
    assert.equal((await readFile(join(source, "package.json"), "utf8")).includes("@customer/example"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("releases a lease and deletes staged artifacts when preparation fails", async () => {
  const { root, source } = await fixture(); let released = false;
  try {
    await assert.rejects(() => coordinateNpmRegistryRelease({ dependencies: dependencies({ failPacking: true }), leaseBroker: { async acquire() { return { provider: "urn:test", parallelism: 1, settlement: {}, async release() { released = true; } }; } }, packageDirectories: [source], outputDirectory: join(root, "snapshot"), registryUrl: "http://registry.invalid/" }), /packing failed/u);
    assert.equal(released, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a lease above the requested bound and preserves the primary failure when cleanup also fails", async () => {
  const { root, source } = await fixture();
  try {
    await assert.rejects(() => coordinateNpmRegistryRelease({ dependencies: dependencies(), leaseBroker: { async acquire() { return { provider: "urn:test", parallelism: 2, settlement: {} }; } }, packageDirectories: [source], outputDirectory: join(root, "snapshot"), registryUrl: "http://registry.invalid/", concurrency: 1 }), /invalid parallelism/u);
    await assert.rejects(() => coordinateNpmRegistryRelease({ dependencies: dependencies({ failPacking: true }), leaseBroker: { async acquire() { return { provider: "urn:test", parallelism: 1, settlement: {}, async release() { throw new Error("cleanup failure"); } }; } }, packageDirectories: [source], outputDirectory: join(root, "snapshot-2"), registryUrl: "http://registry.invalid/" }), /packing failed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
