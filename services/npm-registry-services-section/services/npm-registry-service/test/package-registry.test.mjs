import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { createPackageRegistryServer, buildPackageRegistry, recoverPackageRegistryReceipt, resolvePackageRegistryRequest, rewriteMetadataTarballOrigins } from "../src/package-registry.mjs";

function tarEntries(gzip) {
  const archive = gunzipSync(gzip), entries = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
    const name = `${field(345, 155)}${field(0, 100)}`;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("tar-entry-size-invalid");
    entries.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("packs and serves a package, stripping custom x- fields from what it publishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-"));
  try {
    const carrier = join(root, "carrier");
    const registry = join(root, "registry");
    await mkdir(carrier);
    await writeFile(join(carrier, "package.json"), `${JSON.stringify({
      name: "@customer/example",
      version: "1.0.0",
      type: "module",
      exports: "./index.mjs",
      "x-semiotic-voxel": {
        profile: "org.example.legacy-profile.v1",
        owner: "customer",
        kind: "capability-cell",
        actor: "urn:ame:customer-example",
        operations: ["transform-example"],
        capabilities: [{ capability: "customer-example", faces: ["transform-example"] }],
        package: "@customer/example",
      },
      "x-agentic-metro-enterprise": {
        "node-id": "customer-example",
        actor: "urn:ame:customer-example",
        "organizational-kind": "capability-cell",
        "operation-catalog": {
          "transform-example": {
            accepts: "one example input",
            returns: "one example output",
          },
        },
      },
    })}\n`);
    await writeFile(join(carrier, "index.mjs"), "export const value = 1;\n");
    await mkdir(join(carrier, "src", "child"), { recursive: true });
    await writeFile(join(carrier, "src", "actor.mjs"), "export const actor = true;\n");
    await writeFile(join(carrier, "src", "child", "package.json"), `${JSON.stringify({ name: "@customer/child", version: "1.0.0" })}\n`);
    await mkdir(join(carrier, "content", "contracts"), { recursive: true });
    await mkdir(join(carrier, "content", "exchanges"), { recursive: true });
    await writeFile(join(carrier, "content", "contracts", "law.rml"), "(map)\n");
    await writeFile(join(carrier, "content", "exchanges", "instance.json"), "{}\n");
    const receipt = await buildPackageRegistry({ packageDirectories: [carrier], outputDirectory: registry, registryUrl: "http://127.0.0.1:4873/" });
    assert.equal(receipt.version, 2);
    assert.equal(receipt.packages.length, 1);
    assert.equal("x-semiotic-voxel" in receipt.packages[0], false);
    assert.equal("x-agentic-metro-enterprise" in receipt.packages[0], false);
    assert.match(await readFile(join(registry, "client.npmrc"), "utf8"), /@customer:registry=/u);
    const metadataPath = await resolvePackageRegistryRequest({ registryDirectory: registry, requestPath: "/@customer%2Fexample" });
    assert.ok(metadataPath);
    const published = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(published["dist-tags"].latest, "1.0.0");
    assert.equal("x-semiotic-voxel" in published.versions["1.0.0"], false);
    assert.equal("x-agentic-metro-enterprise" in published.versions["1.0.0"], false);
    const archiveListing = tarEntries(await readFile(join(registry, receipt.packages[0].artifact))).join("\n");
    assert.match(archiveListing, /package\/index\.mjs/u);
    assert.match(archiveListing, /package\/src\/actor\.mjs/u);
    assert.match(archiveListing, /package\/content\/contracts\/law\.rml/u);
    assert.doesNotMatch(archiveListing, /src\/child/u);
    assert.doesNotMatch(archiveListing, /content\/exchanges/u);
    assert.equal(await resolvePackageRegistryRequest({ registryDirectory: registry, requestPath: "/../../etc/passwd" }), null);
    assert.equal(typeof createPackageRegistryServer({ registryDirectory: registry }).listen, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers a real carrier when npm pack's piped JSON output is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-real-carrier-"));
    const actuator = fileURLToPath(new URL("../../../../../../../../../../resource-brokerage-service-section/services/authority-custody-actuator", import.meta.url));
    try {
      const receipt = await buildPackageRegistry({ packageDirectories: [actuator], outputDirectory: join(root, "registry"), registryUrl: "http://127.0.0.1:4873/" });
    const manifest = JSON.parse(await readFile(join(actuator, "package.json"), "utf8"));
    assert.deepEqual(receipt.packages.map(({ name, version }) => ({ name, version })), [{ name: manifest.name, version: manifest.version }]);
    assert.equal("x-semiotic-voxel" in receipt.packages[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses generic package ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-refusal-"));
  try {
    const carrier = join(root, "carrier");
    await mkdir(carrier);
    await writeFile(join(carrier, "package.json"), `${JSON.stringify({ name: "@emsenn/example", version: "1.0.0", "x-semiotic-voxel": { package: "@emsenn/example" } })}\n`);
    await assert.rejects(() => buildPackageRegistry({ packageDirectories: [carrier], outputDirectory: join(root, "registry"), registryUrl: "http://127.0.0.1:4873/" }), /not sovereign/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewrites metadata tarballs to the requesting private registry face", () => {
  const metadata = rewriteMetadataTarballOrigins({
    versions: { "1.0.0": { dist: { tarball: "http://127.0.0.1:4873/tarballs/customer/example/-/example-1.0.0.tgz" } } },
  }, "https://registry.example.test");
  assert.equal(metadata.versions["1.0.0"].dist.tarball, "https://registry.example.test/tarballs/customer/example/-/example-1.0.0.tgz");
});

test("extends a base registry without discarding its published packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-base-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), base = join(root, "base"), next = join(root, "next");
    for (const [directory, name] of [[first, "@customer/first"], [second, "@customer/second"]]) {
      await mkdir(directory);
      await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.mjs", "x-semiotic-voxel": { package: name } })}\n`);
      await writeFile(join(directory, "index.mjs"), "export const value = 1;\n");
    }
    await buildPackageRegistry({ packageDirectories: [first], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    const receipt = await buildPackageRegistry({ packageDirectories: [second], outputDirectory: next, baseRegistryDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    assert.equal(receipt.packages.length, 2);
    assert.ok(await resolvePackageRegistryRequest({ registryDirectory: next, requestPath: "/@customer%2Ffirst" }));
    assert.ok(await resolvePackageRegistryRequest({ registryDirectory: next, requestPath: "/@customer%2Fsecond" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a missing receipt from the verified metadata and tarballs", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-recovery-"));
  try {
    const carrier = join(root, "carrier"), registry = join(root, "registry");
    await mkdir(carrier);
    await writeFile(join(carrier, "package.json"), `${JSON.stringify({ name: "@customer/recoverable", version: "1.2.3", "x-semiotic-voxel": { package: "@customer/recoverable" } })}\n`);
    await buildPackageRegistry({ packageDirectories: [carrier], outputDirectory: registry, registryUrl: "http://127.0.0.1:4873/" });
    await rm(join(registry, "registry-receipt.json"));
    const receipt = await recoverPackageRegistryReceipt({ registryDirectory: registry, registryUrl: "http://127.0.0.1:4873/" });
    assert.deepEqual(receipt.packages.map(({ name, version }) => ({ name, version })), [{ name: "@customer/recoverable", version: "1.2.3" }]);
    assert.equal(receipt.packageCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exposes npm health semantics on its read-only registry face", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-health-"));
  const server = createPackageRegistryServer({ registryDirectory: root });
  try {
    await new Promise((resolveListen) => server.listen(4878, "127.0.0.1", resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const ping = await fetch(`${origin}/-/ping`);
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), {});
    const whoami = await fetch(`${origin}/-/whoami`);
    assert.equal(whoami.status, 401);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});

test("fabricates a rectified snapshot without an explicitly superseded base release", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-base-exclusion-"));
  try {
    const oldCarrier = join(root, "old"), retainedCarrier = join(root, "retained"), base = join(root, "base"), next = join(root, "next");
    for (const [directory, name] of [[oldCarrier, "@customer/old"], [retainedCarrier, "@customer/retained"]]) {
      await mkdir(directory);
      await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.mjs", "x-semiotic-voxel": { package: name } })}\n`);
      await writeFile(join(directory, "index.mjs"), "export const value = 1;\n");
    }
    await buildPackageRegistry({ packageDirectories: [oldCarrier, retainedCarrier], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    const receipt = await buildPackageRegistry({
      packageDirectories: [retainedCarrier],
      outputDirectory: next,
      baseRegistryDirectory: base,
      excludedBaseReleases: ["@customer/old@1.0.0"],
      registryUrl: "http://127.0.0.1:4873/",
    });
    assert.deepEqual(receipt.packages.map(({ name }) => name), ["@customer/retained"]);
    assert.equal(await resolvePackageRegistryRequest({ registryDirectory: next, requestPath: "/@customer%2Fold" }), null);
    assert.equal((await readdir(join(next, "tarballs", "customer", "old", "-"))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects workspace dependencies to exact admitted release versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-workspace-address-"));
  try {
    const provider = join(root, "provider"), consumer = join(root, "consumer"), base = join(root, "base"), next = join(root, "next");
    await mkdir(provider);
    await writeFile(join(provider, "package.json"), `${JSON.stringify({ name: "@customer/provider", version: "2.3.4", type: "module", exports: "./index.mjs", "x-semiotic-voxel": { package: "@customer/provider" } })}\n`);
    await writeFile(join(provider, "index.mjs"), "export const value = 1;\n");
    await buildPackageRegistry({ packageDirectories: [provider], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });

    const sourceManifest = { name: "@customer/consumer", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "@customer/provider": "workspace:*" }, "x-semiotic-voxel": { package: "@customer/consumer" } };
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify(sourceManifest)}\n`);
    await writeFile(join(consumer, "index.mjs"), "export { value } from '@customer/provider';\n");
    await buildPackageRegistry({ packageDirectories: [consumer], outputDirectory: next, baseRegistryDirectory: base, registryUrl: "http://127.0.0.1:4873/" });

    const metadata = JSON.parse(await readFile(join(next, "metadata", "%40customer%2Fconsumer.json"), "utf8"));
    assert.equal(metadata.versions["1.0.0"].dependencies["@customer/provider"], "2.3.4");
    assert.equal(JSON.parse(await readFile(join(consumer, "package.json"), "utf8")).dependencies["@customer/provider"], "workspace:*");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a workspace dependency absent from the admitted release catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-workspace-refusal-"));
  try {
    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "@customer/consumer", version: "1.0.0", dependencies: { "@customer/absent": "workspace:*" }, "x-semiotic-voxel": { package: "@customer/consumer" } })}\n`);
    const registry = join(root, "registry");
    await assert.rejects(() => buildPackageRegistry({ packageDirectories: [consumer], outputDirectory: registry, registryUrl: "http://127.0.0.1:4873/" }), /workspace provider is absent/u);
    assert.deepEqual(await readdir(registry), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a package count that matches the number of metadata files on disk, distinct from the release count", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-package-count-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), base = join(root, "base"), next = join(root, "next");
    for (const [directory, name] of [[first, "@customer/first"], [second, "@customer/second"]]) {
      await mkdir(directory);
      await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version: "1.0.0", "x-semiotic-voxel": { package: name } })}\n`);
    }
    await buildPackageRegistry({ packageDirectories: [first], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    const firstUpgrade = join(root, "first-upgrade");
    await mkdir(firstUpgrade);
    await writeFile(join(firstUpgrade, "package.json"), `${JSON.stringify({ name: "@customer/first", version: "1.0.1", "x-semiotic-voxel": { package: "@customer/first" } })}\n`);
    const receipt = await buildPackageRegistry({
      packageDirectories: [firstUpgrade, second],
      outputDirectory: next,
      baseRegistryDirectory: base,
      registryUrl: "http://127.0.0.1:4873/",
    });
    // Two releases of @customer/first (1.0.0 carried, 1.0.1 fabricated) plus
    // one release of @customer/second: three release entries, but only two
    // distinct package names, and thus two metadata files on disk.
    assert.equal(receipt.packages.length, 3);
    assert.equal(receipt.packageCount, 2);
    assert.deepEqual((await readdir(join(next, "metadata"))).sort(), ["%40customer%2Ffirst.json", "%40customer%2Fsecond.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to finalize a build whose base registry carries workspace: contamination forward, even for a release this run never touched", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-carried-contamination-"));
  try {
    const carrier = join(root, "carrier"), untouched = join(root, "untouched"), base = join(root, "base"), next = join(root, "next");
    await mkdir(carrier);
    await writeFile(join(carrier, "package.json"), `${JSON.stringify({ name: "@customer/carrier", version: "1.0.0", "x-semiotic-voxel": { package: "@customer/carrier" } })}\n`);
    await mkdir(untouched);
    await writeFile(join(untouched, "package.json"), `${JSON.stringify({ name: "@customer/untouched", version: "1.0.0", "x-semiotic-voxel": { package: "@customer/untouched" } })}\n`);
    await buildPackageRegistry({ packageDirectories: [carrier, untouched], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    // Simulate a release that predates the workspace: rewrite fix having
    // already made it into a base registry's metadata (this house's real
    // defect-3 evidence: @red-cup-engineering/animating@0.0.1 carrying an
    // unrewritten workspace:* into published metadata).
    const untouchedMetadataPath = join(base, "metadata", "%40customer%2Funtouched.json");
    const untouchedMetadata = JSON.parse(await readFile(untouchedMetadataPath, "utf8"));
    untouchedMetadata.versions["1.0.0"].dependencies = { "@customer/carrier": "workspace:*" };
    await writeFile(untouchedMetadataPath, JSON.stringify(untouchedMetadata));

    const another = join(root, "another");
    await mkdir(another);
    await writeFile(join(another, "package.json"), `${JSON.stringify({ name: "@customer/another", version: "1.0.0", "x-semiotic-voxel": { package: "@customer/another" } })}\n`);
    await assert.rejects(
      () => buildPackageRegistry({ packageDirectories: [another], outputDirectory: next, baseRegistryDirectory: base, registryUrl: "http://127.0.0.1:4873/" }),
      /workspace: protocol survives into published metadata.*@customer\/untouched@1\.0\.0/su,
    );
    assert.deepEqual(await readdir(next), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buys bounded parallel CPU capacity from an injected compute market", async () => {
  const root = await mkdtemp(join(tmpdir(), "voxel-registry-market-"));
  let demand;
  let released = false;
  try {
    const carrier = join(root, "carrier");
    await mkdir(carrier);
    await writeFile(join(carrier, "package.json"), `${JSON.stringify({ name: "@customer/market-example", version: "1.0.0", "x-semiotic-voxel": { package: "@customer/market-example" } })}\n`);
    const receipt = await buildPackageRegistry({
      packageDirectories: [carrier],
      outputDirectory: join(root, "registry"),
      registryUrl: "http://127.0.0.1:4873/",
      concurrency: 12,
      computeMarket: {
        async procure(offeredDemand) {
          demand = offeredDemand;
          return {
            provider: "urn:provider:compute-market-winner",
            parallelism: 6,
            settlement: { type: "ComputeLeaseSettlement", id: "urn:settlement:1" },
            async release() { released = true; },
          };
        },
      },
    });
    assert.equal(demand.resource, "cpu-process-slot");
    assert.equal(demand.maximumParallelism, 12);
    assert.equal(receipt.compute.provider, "urn:provider:compute-market-winner");
    assert.equal(receipt.compute.parallelism, 6);
    assert.equal(released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
