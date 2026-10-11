import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recoverPackageRegistryReceipt } from "../scripts/recover-package-registry-receipt.mjs";
import { measureArtifactBytes } from "@red-cup-engineering/npm-registry-services-section/npm-artifact-integrity-service";

async function writeRelease(root, { name, version, bytes }) {
  const [scope, leaf] = name.slice(1).split("/");
  const artifact = `tarballs/${scope}/${leaf}/-/${leaf}-${version}.tgz`;
  await mkdir(join(root, "metadata"), { recursive: true });
  await mkdir(join(root, artifact, ".."), { recursive: true });
  await writeFile(join(root, artifact), bytes);
  const { shasum, integrity } = measureArtifactBytes(bytes);
  const metadataPath = join(root, "metadata", `${encodeURIComponent(name)}.json`);
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    metadata = { name, versions: {} };
  }
  metadata.versions[version] = { name, version, dist: { tarball: `http://registry.invalid/${artifact}`, shasum, integrity } };
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
}

test("recovers a deterministically ordered receipt from verified catalog artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-receipt-recovery-"));
  try {
    await writeRelease(root, { name: "@zeta/example", version: "1.0.0", bytes: Buffer.from("zeta") });
    await writeRelease(root, { name: "@alpha/example", version: "1.0.1", bytes: Buffer.from("alpha-1") });
    await writeRelease(root, { name: "@alpha/example", version: "1.0.0", bytes: Buffer.from("alpha-0") });

    const receipt = await recoverPackageRegistryReceipt({ registryDirectory: root, registryUrl: "https://registry.example.test/catalog/" });

    assert.deepEqual(receipt.packages.map(({ name, version }) => ({ name, version })), [
      { name: "@alpha/example", version: "1.0.0" },
      { name: "@alpha/example", version: "1.0.1" },
      { name: "@zeta/example", version: "1.0.0" },
    ]);
    assert.equal(receipt.packages[0].tarball, "https://registry.example.test/catalog/tarballs/alpha/example/-/example-1.0.0.tgz");
    assert.equal(receipt.packageCount, 2);
    assert.deepEqual(receipt.scopes, ["alpha", "zeta"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses recovery when an artifact fails its recorded digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-receipt-recovery-"));
  try {
    await writeRelease(root, { name: "@customer/example", version: "1.2.3", bytes: Buffer.from("expected") });
    await writeFile(join(root, "tarballs/customer/example/-/example-1.2.3.tgz"), "tampered");
    await assert.rejects(
      () => recoverPackageRegistryReceipt({ registryDirectory: root, registryUrl: "http://127.0.0.1:4873/" }),
      /registry tarball digest mismatch: @customer\/example@1\.2\.3/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
