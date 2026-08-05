import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeJsnodePackageBody } from "../src/normalize-jsnode-package-body.mjs";

test("composes the atomic services into one package-body normalization reaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-package-body-"));
  try {
    const base = "lib/emsenn/services/561-group/services/red-cup-engineering/services";
    const provider = base + "/provider", consumer = base + "/consumer";
    await mkdir(join(root, provider, "src"), { recursive: true });
    await mkdir(join(root, consumer, "src"), { recursive: true });
    await writeFile(join(root, provider, "package.json"), JSON.stringify({ name: "@emsenn/provider", version: "3.0.0", exports: "./src/index.mjs", "x-agentic-metro-enterprise": { actor: "urn:ame:provider", "operation-catalog": { provide: {} } } }) + "\n");
    await writeFile(join(root, provider, "src/value.mjs"), "export const value = 3;\n");
    await writeFile(join(root, consumer, "package.json"), JSON.stringify({ name: "@emsenn/consumer", packageManager: "pnpm@11", dependencies: { "@emsenn/provider": "workspace:*" }, exports: "./src/index.mjs" }) + "\n");
    await writeFile(join(root, consumer, "src/index.mjs"), "export { value } from '../../provider/src/value.mjs';\n");
    const receipt = await normalizeJsnodePackageBody({ root, apply: true });
    assert.equal(receipt.packages, 2);
    assert.equal(receipt.packageContractEdgesChanged, 1);
    const providerManifest = JSON.parse(await readFile(join(root, provider, "package.json"), "utf8"));
    const consumerManifest = JSON.parse(await readFile(join(root, consumer, "package.json"), "utf8"));
    assert.equal(providerManifest.name, "@red-cup-engineering/provider");
    assert.equal(providerManifest.exports["./src/value.mjs"], "./src/value.mjs");
    assert.deepEqual(consumerManifest.dependencies, { "@red-cup-engineering/provider": "3.0.0" });
    assert.equal(consumerManifest.packageManager, undefined);
    assert.equal(await readFile(join(root, consumer, "src/index.mjs"), "utf8"), "export { value } from '@red-cup-engineering/provider/src/value.mjs';\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
