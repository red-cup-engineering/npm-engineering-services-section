import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  materializeNodeRuntimeContainerImageContext,
  RECEIPT_FILE,
  verifyNodeRuntimeContainerImageContext,
} from "../src/materialize-context.mjs";
import {
  materializeNodeRuntimeReleaseCatalog,
  verifyNodeRuntimeRelease,
  verifyNodeRuntimeReleaseCatalog,
} from "../../node-runtime-release-materialization-service/src/materialize-release.mjs";

const runtimeReleaseAuthority = { verifyNodeRuntimeRelease, verifyNodeRuntimeReleaseCatalog };

async function write(path, body, mode) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, mode === undefined ? undefined : { mode });
}

async function fixture(names = ["alpha", "notebook"]) {
  const root = await mkdtemp(join("/tmp", "node-container-context-test-")), entries = [];
  for (const name of names) {
    const packageRoot = join(root, "packages", name);
    await write(join(packageRoot, "package.json"), `${JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0", type: "module", files: ["a/", "a-", "src/", ...(name === "notebook" ? ["requirements.lock"] : [])] }, null, 2)}\n`);
    // Cross-owner ordering fixture: the release owner visits directory `a`
    // recursively before sibling file `a-`; a flattened path sort does not.
    await write(join(packageRoot, "a/x"), `${name}-nested\n`);
    await write(join(packageRoot, "a-"), `${name}-sibling\n`);
    await write(join(packageRoot, "src/server.mjs"), `export const service = ${JSON.stringify(name)};\n`, 0o755);
    if (name === "notebook") await write(join(packageRoot, "requirements.lock"), `notebooklm-py==0.7.3 --hash=sha256:${"a".repeat(64)}\n`);
    entries.push({ id: name, entryPackageDirectory: packageRoot });
  }
  const catalog = await materializeNodeRuntimeReleaseCatalog({ entries, outputRoot: join(root, "runtime") });
  const verificationObservation = await verifyNodeRuntimeReleaseCatalog(catalog.catalogDirectory);
  const runtimeReleaseCatalogReceipt = JSON.parse(await readFile(join(catalog.catalogDirectory, "runtime-release-catalog.json"), "utf8"));
  return { root, catalog, verificationObservation, runtimeReleaseCatalogReceipt };
}

function policy(entries) {
  return { type: "NodeRuntimeContainerImageLayoutPolicy", version: 1, entries };
}

test("mixed Node and companion-artifact entries materialize with exact static carriers", async () => {
  const value = await fixture();
  try {
    const staticRoot = join(value.root, "static-source");
    await write(join(staticRoot, "runtime/start.mjs"), "export const start = true;\n", 0o755);
    const output = join(value.root, "context");
    const receipt = await materializeNodeRuntimeContainerImageContext({
      catalogDirectory: value.catalog.catalogDirectory,
      runtimeReleaseCatalogReceipt: value.runtimeReleaseCatalogReceipt,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "notebook", mount: "gemini-notebook" }, { id: "alpha", mount: "services/alpha" }]),
      staticCarriers: [
        { path: "runtime-assets", sourcePath: staticRoot },
        { path: "Dockerfile", utf8: "FROM scratch\n" },
        { path: "binary.dat", base64: Buffer.from([1, 2, 3]).toString("base64") },
      ],
      outputDirectory: output,
    }, { runtimeReleaseAuthority });
    assert.equal(receipt.entries.length, 2);
    assert.equal(receipt.entries.find(({ id }) => id === "notebook").mount, "gemini-notebook");
    assert.equal(await readFile(join(output, "gemini-notebook/requirements.lock"), "utf8").then((text) => text.includes("notebooklm-py")), true);
    assert.equal(receipt.staticCarriers.length, 3);
    assert.equal(receipt.identityScope, "regular-file-path-bytes-mode");
    const observed = await verifyNodeRuntimeContainerImageContext({ contextDirectory: output });
    assert.equal(observed.ok, true, JSON.stringify(observed));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("single-entry contexts are first-class and two output paths have identical receipts", async () => {
  const value = await fixture(["worker"]);
  try {
    const input = {
      catalogDirectory: value.catalog.catalogDirectory,
      runtimeReleaseCatalogReceipt: value.runtimeReleaseCatalogReceipt,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "worker", mount: "app" }]),
      staticCarriers: [{ path: "entrypoint.txt", utf8: "node app/src/server.mjs\n" }],
    };
    const first = await materializeNodeRuntimeContainerImageContext({ ...input, outputDirectory: join(value.root, "one") }, { runtimeReleaseAuthority });
    const second = await materializeNodeRuntimeContainerImageContext({ ...input, outputDirectory: join(value.root, "two") }, { runtimeReleaseAuthority });
    assert.deepEqual(first, second);
    assert.equal(first.entries[0].id, "worker");
    const observed = await verifyNodeRuntimeContainerImageContext({ contextDirectory: join(value.root, "two"), receipt: second });
    assert.equal(observed.ok, true, JSON.stringify(observed));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a release mutated after its supplied verification is refused before output", async () => {
  const value = await fixture(["worker"]);
  try {
    const release = value.catalog.entries[0];
    await writeFile(join(value.catalog.catalogDirectory, release.releaseRelativePath, "app/src/server.mjs"), "export const changed = true;\n");
    await assert.rejects(materializeNodeRuntimeContainerImageContext({
      catalogDirectory: value.catalog.catalogDirectory,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "worker", mount: "app" }]),
      outputDirectory: join(value.root, "context"),
    }, { runtimeReleaseAuthority }), /fresh runtime catalog verification differs/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("a release replaced immediately after release-owner verification is refused by copied-byte remeasurement", async () => {
  const value = await fixture(["worker"]);
  try {
    let mutated = false;
    const adversarialAuthority = {
      verifyNodeRuntimeReleaseCatalog,
      async verifyNodeRuntimeRelease(directory) {
        const observation = await verifyNodeRuntimeRelease(directory);
        if (!mutated) {
          mutated = true;
          await writeFile(join(directory, "app/src/server.mjs"), "export const replacedAfterVerification = true;\n");
        }
        return observation;
      },
    };
    await assert.rejects(materializeNodeRuntimeContainerImageContext({
      catalogDirectory: value.catalog.catalogDirectory,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "worker", mount: "app" }]),
      outputDirectory: join(value.root, "context"),
    }, { runtimeReleaseAuthority: adversarialAuthority }), /copied runtime release worker differs/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("entry, static, and receipt destination overlap are refused", async () => {
  const value = await fixture();
  try {
    const base = {
      catalogDirectory: value.catalog.catalogDirectory,
      verificationObservation: value.verificationObservation,
      outputDirectory: join(value.root, "context"),
    };
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, layoutPolicy: policy([{ id: "alpha", mount: "app" }, { id: "notebook", mount: "app/notebook" }]) }, { runtimeReleaseAuthority }), /mounts overlap/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, layoutPolicy: policy([{ id: "alpha", mount: "alpha" }, { id: "notebook", mount: "notebook" }]), staticCarriers: [{ path: "alpha/config.json", utf8: "{}" }] }, { runtimeReleaseAuthority }), /overlaps runtime mount/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, layoutPolicy: policy([{ id: "alpha", mount: "alpha" }, { id: "notebook", mount: "notebook" }]), staticCarriers: [{ path: RECEIPT_FILE, utf8: "{}" }] }, { runtimeReleaseAuthority }), /receipt/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("traversal, symbolic links, credential names, and secret bytes are refused", async () => {
  const value = await fixture(["worker"]);
  try {
    const source = join(value.root, "static"), target = join(value.root, "target.txt");
    await mkdir(source); await write(target, "ordinary\n"); await symlink(target, join(source, "linked.txt"));
    const base = {
      catalogDirectory: value.catalog.catalogDirectory,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "worker", mount: "app" }]),
    };
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: "../escape", utf8: "x" }], outputDirectory: join(value.root, "one") }, { runtimeReleaseAuthority }), /traversal/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: "assets", sourcePath: source }], outputDirectory: join(value.root, "two") }, { runtimeReleaseAuthority }), /unsupported filesystem carrier/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: ".npmrc", utf8: "registry=https://example.test\n" }], outputDirectory: join(value.root, "three") }, { runtimeReleaseAuthority }), /credential-shaped/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: "config.txt", utf8: "-----BEGIN PRIVATE KEY-----\nsecret\n" }], outputDirectory: join(value.root, "four") }, { runtimeReleaseAuthority }), /secret material/u);
    const largeSecret = `${"x".repeat(2 * 1024 * 1024 + 1)}\n-----BEGIN PRIVATE KEY-----\nsecret\n`;
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: "large.bin", utf8: largeSecret }], outputDirectory: join(value.root, "five") }, { runtimeReleaseAuthority }), /secret material/u);
    const nulSecret = Buffer.from("ordinary\0\n_authToken=not-a-real-token\n", "utf8").toString("base64");
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, staticCarriers: [{ path: "nul.bin", base64: nulSecret }], outputDirectory: join(value.root, "six") }, { runtimeReleaseAuthority }), /secret material/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("existing outputs, inexact observations, and incomplete layouts are refused", async () => {
  const value = await fixture(["worker"]);
  try {
    const output = join(value.root, "existing"); await mkdir(output);
    const base = { catalogDirectory: value.catalog.catalogDirectory, verificationObservation: value.verificationObservation, layoutPolicy: policy([{ id: "worker", mount: "app" }]), outputDirectory: output };
    await assert.rejects(materializeNodeRuntimeContainerImageContext(base, { runtimeReleaseAuthority }), /must not already exist/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, outputDirectory: join(value.root, "other"), verificationObservation: { ...value.verificationObservation, observedDigest: "0".repeat(64) } }, { runtimeReleaseAuthority }), /does not verify/u);
    await assert.rejects(materializeNodeRuntimeContainerImageContext({ ...base, outputDirectory: join(value.root, "another"), layoutPolicy: policy([]) }, { runtimeReleaseAuthority }), /every catalog entry/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("verification detects file, receipt, static-carrier, and mounted-artifact tampering", async () => {
  const value = await fixture(["worker"]);
  try {
    const output = join(value.root, "context");
    const receipt = await materializeNodeRuntimeContainerImageContext({
      catalogDirectory: value.catalog.catalogDirectory,
      verificationObservation: value.verificationObservation,
      layoutPolicy: policy([{ id: "worker", mount: "app" }]),
      staticCarriers: [{ path: "Dockerfile", utf8: "FROM scratch\n" }],
      outputDirectory: output,
    }, { runtimeReleaseAuthority });
    await writeFile(join(output, "app/src/server.mjs"), "export const tampered = true;\n");
    const observation = await verifyNodeRuntimeContainerImageContext({ contextDirectory: output, receipt });
    assert.equal(observation.ok, false);
    assert.match(observation.defects.join("\n"), /final-file-identities-differ|runtime-artifact-differs/u);
    const falseReceipt = structuredClone(receipt); falseReceipt.files[0].sha256 = "0".repeat(64);
    await assert.rejects(verifyNodeRuntimeContainerImageContext({ contextDirectory: output, receipt: falseReceipt }), /canonical digest is invalid/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
