import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  materializeNodeRuntimeRelease,
  materializeNodeRuntimeReleaseCatalog,
  materializeNodeRuntimeProviderCatalog,
  verifyNodeRuntimeRelease,
  verifyNodeRuntimeReleaseCatalog,
} from "../src/materialize-release.mjs";

function tarHeader(path, bytes, mode = 0o644, type = "0") {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = type.codePointAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function npmTarball(root, name, files) {
  const parts = [];
  const entries = Array.isArray(files) ? files : Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  for (const [path, contents, mode = 0o644, type = "0"] of entries) {
    const bytes = Buffer.from(contents);
    parts.push(tarHeader(path, bytes, mode, type), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
  const path = join(root, name);
  await writeFile(path, bytes);
  return { path, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

test("materializes a deterministic isolated local runtime closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-materialization-test-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", type: "module", dependencies: { "@test/library": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import { value } from "@test/library"; console.log(value);\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "@test/library", version: "1.0.0", type: "module", files: ["dist"], exports: "./dist/index.mjs" }));
    await writeFile(join(library, "dist", "index.mjs"), 'export const value = "closed";\n');

    const first = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") });
    const second = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") });
    assert.equal(first.artifactDigest, second.artifactDigest);
    assert.deepEqual(first.packages.map(({ name }) => name), ["@test/app", "@test/library"]);
    assert.equal((await verifyNodeRuntimeRelease(first.releaseDirectory)).ok, true);
    assert.match(await readFile(join(first.releaseDirectory, "app", "node_modules", "@test", "library", "dist", "index.mjs"), "utf8"), /closed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hoists one admitted transitive provider for sibling consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-hoisted-transitive-"));
  try {
    const app = join(root, "workspace", "app");
    const one = join(root, "workspace", "one");
    const two = join(root, "workspace", "two");
    const shared = join(root, "workspace", "shared");
    for (const directory of [app, one, two, shared]) await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/one": "1.0.0", "@test/two": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/one"; import "@test/two";\n');
    for (const [directory, name] of [[one, "@test/one"], [two, "@test/two"]]) {
      await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./src/index.mjs", dependencies: { "@test/shared": "1.0.0" } }));
      await writeFile(join(directory, "src", "index.mjs"), 'import "@test/shared";\n');
    }
    await writeFile(join(shared, "package.json"), JSON.stringify({ name: "@test/shared", version: "1.0.0", type: "module", exports: "./src/index.mjs" }));
    await writeFile(join(shared, "src", "index.mjs"), "export {};\n");
    const release = await materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerSources: { "@test/one": one, "@test/two": two, "@test/shared": shared },
      outputRoot: join(root, "releases"),
    });
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
    assert.match(await readFile(join(release.releaseDirectory, "app", "node_modules", "@test", "shared", "src", "index.mjs"), "utf8"), /export/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copies root export carriers selected by root-level files globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-root-glob-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/library": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/library";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "@test/library", version: "1.0.0", type: "module", files: ["src", "**/*.mjs"], exports: "./index.mjs" }));
    await writeFile(join(library, "index.mjs"), "export {};\n");
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") });
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
    assert.match(await readFile(join(release.releaseDirectory, "app", "node_modules", "@test", "library", "index.mjs"), "utf8"), /export/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies conventional main targets that omit the dot slash prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-conventional-main-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(library, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { conventional: "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "conventional";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "conventional", version: "1.0.0", files: ["index.js"], main: "index.js" }));
    await writeFile(join(library, "index.js"), "module.exports = {};\n");
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { conventional: library }, outputRoot: join(root, "releases") });
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification detects post-materialization mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-materialization-tamper-"));
  try {
    const app = join(root, "workspace", "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0" }));
    await writeFile(join(app, "src", "server.mts"), "export const state = 'admitted';\n");
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, outputRoot: join(root, "releases") });
    await writeFile(join(release.releaseDirectory, "app", "src", "server.mts"), "export const state = 'mutated';\n");
    const observation = await verifyNodeRuntimeRelease(release.releaseDirectory);
    assert.equal(observation.ok, false);
    assert.notEqual(observation.expectedDigest, observation.observedDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses undeclared external runtime dependencies instead of consulting ambient state", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-materialization-refusal-"));
  try {
    const app = join(root, "workspace", "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { external: "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    await assert.rejects(
      materializeNodeRuntimeRelease({ entryPackageDirectory: app, outputRoot: join(root, "releases") }),
      /runtime dependency external has no explicitly admitted provider source/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses stale build output that imports a package absent from the admitted closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-runtime-import-refusal-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/library": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/library";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "@test/library", version: "1.0.0", files: ["dist"], exports: "./dist/index.mjs" }));
    await writeFile(join(library, "dist", "index.mjs"), 'import "@obsolete/missing";\n');
    await assert.rejects(
      materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") }),
      /runtime import closure is missing @obsolete\/missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an admitted package whose runtime export carrier is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-runtime-export-refusal-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist", "types"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/library": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/library";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({
      name: "@test/library",
      version: "1.0.0",
      files: ["dist"],
      exports: { ".": { types: "./dist/types/index.d.ts", default: "./dist/runtime/index.mjs" } },
    }));
    await writeFile(join(library, "dist", "types", "index.d.ts"), "export {};\n");
    await assert.rejects(
      materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") }),
      /runtime import closure is missing @test\/library export \. -> \.\/dist\/runtime\/index\.mjs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an unexported literal dynamic runtime subpath", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-dynamic-export-refusal-"));
  try {
    const app = join(root, "app"), library = join(root, "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: { library: "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'await import("library/onchain");\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "library", version: "1.0.0", exports: { ".": "./dist/index.mjs" } }));
    await writeFile(join(library, "dist", "index.mjs"), "export {};\n");
    await assert.rejects(materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { library }, outputRoot: join(root, "output") }), /library export \.\/onchain -> <unexported>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification identifies a runtime export carrier removed from a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-runtime-export-verification-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/library": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/library";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "@test/library", version: "1.0.0", files: ["dist"], exports: "./dist/index.mjs" }));
    await writeFile(join(library, "dist", "index.mjs"), "export {};\n");
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerSources: { "@test/library": library }, outputRoot: join(root, "releases") });
    await rm(join(release.releaseDirectory, "app", "node_modules", "@test", "library", "dist", "index.mjs"));
    const observation = await verifyNodeRuntimeRelease(release.releaseDirectory);
    assert.equal(observation.ok, false);
    assert.deepEqual(observation.unresolvedRuntimePackages, ["@test/library"]);
    assert.deepEqual(observation.unresolvedRuntimeTargets["@test/library"], [{
      specifier: "@test/library",
      subpath: ".",
      target: "./dist/index.mjs",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializes a proof-carried catalog and normalizes only the fabricated dependency edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-catalog-"));
  try {
    const app = join(root, "workspace", "app");
    const library = join(root, "workspace", "library");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(library, "dist"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/library": "workspace:*" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/library";\n');
    await writeFile(join(library, "package.json"), JSON.stringify({ name: "@test/library", version: "2.0.0-beta.1", exports: "./dist/index.mjs" }));
    await writeFile(join(library, "dist", "index.mjs"), "export {};\n");
    const sourceCatalog = {
      type: "NodePackageSourceCatalogReceipt", version: 1, id: "ni:///sha-256;catalog", entryPackage: "@test/app",
      packages: [
        { name: "@test/app", version: "1.0.0", sourceDirectory: app },
        { name: "@test/library", version: "2.0.0-beta.1", sourceDirectory: library },
      ],
    };
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, sourceCatalog, outputRoot: join(root, "releases") });
    const carried = JSON.parse(await readFile(join(release.releaseDirectory, "app", "package.json"), "utf8"));
    assert.equal(carried.dependencies["@test/library"], "2.0.0-beta.1");
    assert.equal(JSON.parse(await readFile(join(app, "package.json"), "utf8")).dependencies["@test/library"], "workspace:*");
    assert.equal(release.sourceCatalog, sourceCatalog.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("types an absent platform-conditional dependency while preserving required closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-platform-optional-"));
  try {
    const app = join(root, "workspace", "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({
      name: "@test/app",
      version: "1.0.0",
      optionalDependencies: { fsevents: "2.3.3" },
    }));
    await writeFile(join(app, "src", "server.mts"), 'import("fsevents").catch(() => undefined);\n');
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, outputRoot: join(root, "releases") });
    assert.deepEqual(release.optionalRuntimePackagesAbsent, ["fsevents"]);
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);

    await writeFile(join(app, "package.json"), JSON.stringify({
      name: "@test/app",
      version: "1.0.0",
      dependencies: { fsevents: "2.3.3" },
    }));
    await assert.rejects(
      materializeNodeRuntimeRelease({ entryPackageDirectory: app, outputRoot: join(root, "releases") }),
      /runtime dependency fsevents has no explicitly admitted provider source/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not project a multiline code fragment as an import specifier", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-import-recognizer-"));
  try {
    const app = join(root, "workspace", "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0" }));
    await writeFile(join(app, "src", "server.mts"), 'const source = /import \\\"unterminated\ncode package.json\"/u;\nexport { source };\n');
    const release = await materializeNodeRuntimeRelease({ entryPackageDirectory: app, outputRoot: join(root, "releases") });
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializes and verifies a mixed source and immutable-tarball transitive closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-mixed-provider-"));
  try {
    const app = join(root, "app");
    const bridge = join(root, "bridge");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(bridge, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/bridge": "1.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "@test/bridge";\n');
    await writeFile(join(bridge, "package.json"), JSON.stringify({ name: "@test/bridge", version: "1.0.0", type: "module", exports: "./src/index.mjs", dependencies: { immutable: "^2.0.0" } }));
    await writeFile(join(bridge, "src", "index.mjs"), 'import "immutable/feature";\n');
    const tarball = await npmTarball(root, "immutable.tgz", {
      "package/package.json": JSON.stringify({ name: "immutable", version: "2.0.0", type: "module", exports: { ".": "./index.mjs", "./feature": "./feature.mjs" } }),
      "package/index.mjs": "export {};\n",
      "package/feature.mjs": "export const feature = true;\n",
    });
    const providerTarballs = { immutable: { name: "immutable", version: "2.0.0", integrity: tarball.integrity, tarballPath: tarball.path } };
    const release = await materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerSources: { "@test/bridge": bridge },
      providerTarballs,
      providerSelections: [{
        requiringPackage: "@test/bridge", name: "immutable", requested: "^2.0.0", selectedVersion: "2.0.0",
        requiringLocation: "node_modules/@test/bridge", lockLocation: "node_modules/immutable",
        integrity: tarball.integrity, resolved: "https://registry.example.test/immutable-2.0.0.tgz",
      }],
      outputRoot: join(root, "output"),
    });
    assert.deepEqual(release.packages, [
      { name: "@test/app", version: "1.0.0", provider: "source" },
      { name: "@test/bridge", version: "1.0.0", provider: "source" },
      { name: "immutable", version: "2.0.0", provider: "tarball", integrity: tarball.integrity },
    ]);
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
    assert.match(await readFile(join(release.releaseDirectory, "app", "node_modules", "immutable", "feature.mjs"), "utf8"), /feature/u);
    const receiptPath = join(release.releaseDirectory, "release-receipt.json");
    const falseReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
    falseReceipt.providerSelections[0].integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    await writeFile(receiptPath, `${JSON.stringify(falseReceipt, null, 2)}\n`);
    const falseObservation = await verifyNodeRuntimeRelease(release.releaseDirectory);
    assert.equal(falseObservation.ok, false);
    assert.equal(falseObservation.providerSelectionViolations[0].reason, "selected-integrity-differs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admits a valid npm tarball with a non-package top-level directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-non-package-root-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@types/node": "22.7.5" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    const tarball = await npmTarball(root, "types-node.tgz", {
      "node/package.json": JSON.stringify({ name: "@types/node", version: "22.7.5", files: ["index.d.ts"] }),
      "node/index.d.ts": "declare const node: true;\n",
    });
    const release = await materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerTarballs: { "@types/node": { name: "@types/node", version: "22.7.5", integrity: tarball.integrity, tarballPath: tarball.path } },
      outputRoot: join(root, "output"),
    });
    assert.equal((await verifyNodeRuntimeRelease(release.releaseDirectory)).ok, true);
    assert.equal(JSON.parse(await readFile(join(release.releaseDirectory, "app", "node_modules", "@types", "node", "package.json"), "utf8")).name, "@types/node");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses npm tarballs with more than one top-level directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-multiple-tar-roots-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { immutable: "2.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    const tarball = await npmTarball(root, "multiple-roots.tgz", {
      "node/package.json": JSON.stringify({ name: "immutable", version: "2.0.0" }),
      "package/index.mjs": "export {};\n",
    });
    await assert.rejects(materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerTarballs: { immutable: { name: "immutable", version: "2.0.0", integrity: tarball.integrity, tarballPath: tarball.path } },
      outputRoot: join(root, "output"),
    }), /one top-level directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses false immutable tarball integrity, identity, version, exports, and imports", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-release-tarball-refusal-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { immutable: "2.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), 'import "immutable/feature";\n');
    const materialize = (claim, output) => materializeNodeRuntimeRelease({ entryPackageDirectory: app, providerTarballs: { immutable: claim }, outputRoot: join(root, output) });
    const good = await npmTarball(root, "good.tgz", {
      "package/package.json": JSON.stringify({ name: "immutable", version: "2.0.0", exports: { "./feature": "./missing.mjs" } }),
      "package/index.mjs": 'import "undeclared";\n',
    });
    const base = { name: "immutable", version: "2.0.0", integrity: good.integrity, tarballPath: good.path };
    await context.test("integrity", () => assert.rejects(materialize({ ...base, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, "integrity"), /integrity mismatch/u));
    await context.test("claimed identity", () => assert.rejects(materialize({ ...base, name: "foreign" }, "claim"), /claim immutable names foreign/u));
    await context.test("contained identity", async () => {
      const foreign = await npmTarball(root, "foreign.tgz", { "package/package.json": JSON.stringify({ name: "foreign", version: "2.0.0" }), "package/index.js": "module.exports = {};\n" });
      await assert.rejects(materialize({ ...base, integrity: foreign.integrity, tarballPath: foreign.path }, "identity"), /contains foreign/u);
    });
    await context.test("contained version", async () => {
      const stale = await npmTarball(root, "stale.tgz", { "package/package.json": JSON.stringify({ name: "immutable", version: "1.9.9" }), "package/index.js": "module.exports = {};\n" });
      await assert.rejects(materialize({ ...base, integrity: stale.integrity, tarballPath: stale.path }, "version"), /claimed 2\.0\.0 but contains 1\.9\.9/u);
    });
    await context.test("missing exported target", () => assert.rejects(materialize(base, "export"), /export \.\/feature -> \.\/missing\.mjs/u));
    await context.test("undeclared transitive import", async () => {
      const badImport = await npmTarball(root, "bad-import.tgz", {
        "package/package.json": JSON.stringify({ name: "immutable", version: "2.0.0", exports: { "./feature": "./feature.mjs" } }),
        "package/feature.mjs": 'import "undeclared";\n',
      });
      await assert.rejects(materialize({ ...base, integrity: badImport.integrity, tarballPath: badImport.path }, "import"), /runtime import closure is missing undeclared/u);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses tar archive traversal before writing a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-tarball-traversal-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { immutable: "2.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    const tarball = await npmTarball(root, "traversal.tgz", {
      "package/package.json": JSON.stringify({ name: "immutable", version: "2.0.0" }),
      "package/../../escaped": "nope",
    });
    await assert.rejects(materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerTarballs: { immutable: { name: "immutable", version: "2.0.0", integrity: tarball.integrity, tarballPath: tarball.path } },
      outputRoot: join(root, "output"),
    }), /traverses its package root/u);
    await assert.rejects(readFile(join(root, "escaped")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composes deterministic multi-entry catalogs and verifies every release", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-catalog-composition-"));
  try {
    const entries = [];
    for (const id of ["zebra", "alpha"]) {
      const directory = join(root, id);
      await mkdir(join(directory, "src"), { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@test/${id}`, version: "1.0.0" }));
      await writeFile(join(directory, "src", "server.mts"), `export const id = ${JSON.stringify(id)};\n`);
      entries.push({ id, entryPackageDirectory: directory });
    }
    const providerSources = Object.fromEntries(entries.map(({ id, entryPackageDirectory }) => [`@test/${id}`, entryPackageDirectory]));
    const first = await materializeNodeRuntimeReleaseCatalog({ entries, providerSources, outputRoot: join(root, "output") });
    const second = await materializeNodeRuntimeReleaseCatalog({ entries: [...entries].reverse(), providerSources, outputRoot: join(root, "different-output") });
    assert.equal(first.digest, second.digest);
    assert.deepEqual(first.entries.map(({ id }) => id), ["alpha", "zebra"]);
    assert.equal(
      await readFile(join(first.catalogDirectory, "runtime-release-catalog.json"), "utf8"),
      await readFile(join(second.catalogDirectory, "runtime-release-catalog.json"), "utf8"),
    );
    assert.equal((await verifyNodeRuntimeReleaseCatalog(first.catalogDirectory)).ok, true);
    await writeFile(resolve(first.catalogDirectory, first.entries[0].releaseRelativePath, "app", "src", "server.mts"), "export const tampered = true;\n");
    const observation = await verifyNodeRuntimeReleaseCatalog(first.catalogDirectory);
    assert.equal(observation.ok, false);
    assert.equal(observation.entries.find(({ id }) => id === "alpha").ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts the publication owner's provider catalog without ambient translation", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-provider-catalog-handoff-"));
  try {
    const make = (filename, manifest) => npmTarball(root, filename, { "package/package.json": JSON.stringify(manifest), "package/index.mjs": "export {};\n" });
    const app = await make("app.tgz", { name: "@test/app", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { left: "1.0.0", right: "1.0.0" } });
    const left = await make("left.tgz", { name: "left", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "content-type": "^1.0.0" } });
    const right = await make("right.tgz", { name: "right", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "content-type": "^2.0.0" } });
    const contentOne = await make("content-one.tgz", { name: "content-type", version: "1.0.5", type: "module", exports: "./index.mjs" });
    const contentTwo = await make("content-two.tgz", { name: "content-type", version: "2.1.0", type: "module", exports: "./index.mjs" });
    const node = (location, name, version, tarball, edges = {}) => ({ location, name, version, authorityKind: "test-tarball", integrity: tarball.integrity, tarballPath: tarball.path, edges });
    const releaseCatalog = await materializeNodeRuntimeProviderCatalog({
      type: "NodeRuntimeProviderCatalog",
      version: 1,
      entries: [{ id: "daily", name: "@test/app", version: "1.0.0" }],
      admissions: { daily: { nodes: {
        "": node("", "@test/app", "1.0.0", app, { left: "node_modules/left", right: "node_modules/right" }),
        "node_modules/left": node("node_modules/left", "left", "1.0.0", left, { "content-type": "node_modules/content-type" }),
        "node_modules/right": node("node_modules/right", "right", "1.0.0", right, { "content-type": "node_modules/right/node_modules/content-type" }),
        "node_modules/content-type": node("node_modules/content-type", "content-type", "1.0.5", contentOne),
        "node_modules/right/node_modules/content-type": node("node_modules/right/node_modules/content-type", "content-type", "2.1.0", contentTwo),
      } } },
    }, join(root, "output"));
    assert.equal(releaseCatalog.entries[0].id, "daily");
    assert.equal((await verifyNodeRuntimeReleaseCatalog(releaseCatalog.catalogDirectory)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports policy records an unused dependency export but rejects an imported one", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-export-policy-"));
  try {
    const dependency = await npmTarball(root, "dependency.tgz", {
      "package/package.json": JSON.stringify({ name: "dependency", version: "1.0.0", type: "module", exports: { ".": "./index.mjs", "./unused": "./missing.mjs" } }),
      "package/index.mjs": "export const available = true;\n",
    });
    const app = async (name, source) => npmTarball(root, `${name}.tgz`, {
      "package/package.json": JSON.stringify({ name: `@test/${name}`, version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { dependency: "1.0.0" } }),
      "package/index.mjs": source,
    });
    const unused = await app("unused-export", 'import "dependency";\n');
    const imported = await app("imported-export", 'import "dependency/unused";\n');
    const node = (location, name, tarball, edges = {}) => ({ location, name, version: "1.0.0", authorityKind: "test-tarball", integrity: tarball.integrity, tarballPath: tarball.path, edges });
    const catalog = (id, appTarball, name) => ({
      type: "NodeRuntimeProviderCatalog", version: 1,
      entries: [{ id, name: `@test/${name}`, version: "1.0.0" }],
      admissions: { [id]: { nodes: {
        "": node("", `@test/${name}`, appTarball, { dependency: "node_modules/dependency" }),
        "node_modules/dependency": node("node_modules/dependency", "dependency", dependency),
      } } },
    });
    await context.test("strict remains the default", async () => {
      await assert.rejects(materializeNodeRuntimeProviderCatalog(catalog("strict", unused, "unused-export"), join(root, "strict")), /dependency export \.\/unused -> \.\/missing\.mjs is absent/u);
    });
    await context.test("unused declared export is receipt evidence under runtime-imports", async () => {
      const release = await materializeNodeRuntimeProviderCatalog(catalog("runtime", unused, "unused-export"), join(root, "runtime"), { dependencyExportPolicy: "runtime-imports", runtimeEntrypoints: ["index.mjs"] });
      const entry = release.entries[0], receipt = JSON.parse(await readFile(join(release.catalogDirectory, entry.releaseRelativePath, "release-receipt.json"), "utf8"));
      assert.equal(receipt.dependencyExportPolicy, "runtime-imports");
      assert.deepEqual(receipt.dependencyExportFindings, [{ location: "node_modules/dependency", package: "dependency", version: "1.0.0", subpath: "./unused", target: "./missing.mjs" }]);
      assert.equal((await verifyNodeRuntimeReleaseCatalog(release.catalogDirectory)).ok, true);
    });
    await context.test("actual import still refuses", async () => {
      await assert.rejects(materializeNodeRuntimeProviderCatalog(catalog("imported", imported, "imported-export"), join(root, "imported"), { dependencyExportPolicy: "runtime-imports", runtimeEntrypoints: ["index.mjs"] }), /runtime import closure is missing dependency/u);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports requires explicit entry roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-roots-"));
  try {
    const app = await npmTarball(root, "app.tgz", { "package/package.json": JSON.stringify({ name: "@test/app", version: "1.0.0", type: "module", exports: "./index.mjs" }), "package/index.mjs": "export {};\n" });
    const node = { location: "", name: "@test/app", version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} };
    const catalog = { type: "NodeRuntimeProviderCatalog", version: 1, entries: [{ id: "app", name: "@test/app", version: "1.0.0" }], admissions: { app: { nodes: { "": node } } } };
    await assert.rejects(materializeNodeRuntimeProviderCatalog(catalog, join(root, "output"), { dependencyExportPolicy: "runtime-imports" }), /requires explicit runtimeEntrypoints/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime-imports refuses reached literal require and dynamic imports", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-literal-imports-"));
  try {
    const catalog = async (id, source) => {
      const app = await npmTarball(root, `${id}.tgz`, { "package/package.json": JSON.stringify({ name: `@test/${id}`, version: "1.0.0", type: "module", exports: "./index.mjs" }), "package/index.mjs": source });
      return { type: "NodeRuntimeProviderCatalog", version: 1, entries: [{ id, name: `@test/${id}`, version: "1.0.0" }], admissions: { [id]: { nodes: { "": { location: "", name: `@test/${id}`, version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} } } } } };
    };
    for (const [id, source] of [["literal-require", 'require("missing-require");\n'], ["literal-dynamic", 'await import("missing-dynamic");\n']]) {
      await context.test(`${id} refuses`, async () => {
        await assert.rejects(materializeNodeRuntimeProviderCatalog(await catalog(id, source), join(root, id), { dependencyExportPolicy: "runtime-imports", runtimeEntrypoints: ["index.mjs"] }), /runtime import closure is missing/u);
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime-imports uses the require conditional export branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-require-conditions-"));
  try {
    const dependency = await npmTarball(root, "conditional.tgz", {
      "package/package.json": JSON.stringify({
        name: "conditional",
        version: "1.0.0",
        exports: { ".": { import: "./import.mjs", require: "./require.cjs" } },
      }),
      "package/import.mjs": 'import "missing-import-target";\n',
      "package/require.cjs": "module.exports = true;\n",
    });
    const app = await npmTarball(root, "app.tgz", {
      "package/package.json": JSON.stringify({ name: "@test/require-conditions", version: "1.0.0", exports: "./index.cjs", dependencies: { conditional: "1.0.0" } }),
      "package/index.cjs": 'require("conditional");\n',
    });
    const node = (location, name, tarball, edges = {}) => ({ location, name, version: "1.0.0", authorityKind: "test-tarball", integrity: tarball.integrity, tarballPath: tarball.path, edges });
    const catalog = {
      type: "NodeRuntimeProviderCatalog",
      version: 1,
      entries: [{ id: "app", name: "@test/require-conditions", version: "1.0.0" }],
      admissions: { app: { nodes: {
        "": node("", "@test/require-conditions", app, { conditional: "node_modules/conditional" }),
        "node_modules/conditional": node("node_modules/conditional", "conditional", dependency),
      } } },
    };
    const release = await materializeNodeRuntimeProviderCatalog(catalog, join(root, "output"), {
      dependencyExportPolicy: "runtime-imports",
      runtimeEntrypoints: ["index.cjs"],
    });
    assert.equal((await verifyNodeRuntimeReleaseCatalog(release.catalogDirectory)).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports refuses extensionless ESM imports and artifact escapes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-esm-relative-"));
  try {
    const catalogFor = async (id, source, files = {}) => {
      const app = await npmTarball(root, `${id}.tgz`, {
        "package/package.json": JSON.stringify({ name: `@test/${id}`, version: "1.0.0", type: "module", exports: "./index.mjs" }),
        "package/index.mjs": source,
        ...Object.fromEntries(Object.entries(files).map(([name, contents]) => [`package/${name}`, contents])),
      });
      return {
        type: "NodeRuntimeProviderCatalog",
        version: 1,
        entries: [{ id, name: `@test/${id}`, version: "1.0.0" }],
        admissions: { [id]: { nodes: { "": { location: "", name: `@test/${id}`, version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} } } } },
      };
    };
    await context.test("extensionless refuses", async () => {
      await assert.rejects(
        materializeNodeRuntimeProviderCatalog(await catalogFor("extensionless", 'import "./local";\n', { "local.mjs": "export {};\n" }), join(root, "extensionless"), {
          dependencyExportPolicy: "runtime-imports",
          runtimeEntrypoints: ["index.mjs"],
        }),
        /runtime import closure is missing/u,
      );
    });
    for (const [id, specifier, location] of [
      ["escape", "../outside.mjs", ["outside.mjs"]],
      ["parent-node-modules", "../node_modules/ambient/index.mjs", ["node_modules", "ambient", "index.mjs"]],
    ]) {
      await context.test(`${id} refuses existing carrier outside app`, async () => {
        const release = await materializeNodeRuntimeProviderCatalog(await catalogFor(id, "export {};\n"), join(root, id), {
          dependencyExportPolicy: "runtime-imports",
          runtimeEntrypoints: ["index.mjs"],
        });
        const entry = release.entries[0];
        const releaseDirectory = join(release.catalogDirectory, entry.releaseRelativePath);
        const outside = join(releaseDirectory, ...location);
        await mkdir(resolve(outside, ".."), { recursive: true });
        await writeFile(outside, "export {};\n");
        await writeFile(join(releaseDirectory, "app", "index.mjs"), `import ${JSON.stringify(specifier)};\n`);
        const observation = await verifyNodeRuntimeRelease(releaseDirectory);
        assert.deepEqual(observation.unresolvedRuntimePackages, [specifier]);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports receipts require nonempty entry roots during verification", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-receipt-roots-"));
  try {
    const app = await npmTarball(root, "app.tgz", {
      "package/package.json": JSON.stringify({ name: "@test/receipt-roots", version: "1.0.0", type: "module", exports: "./index.mjs" }),
      "package/index.mjs": "export {};\n",
    });
    const catalog = {
      type: "NodeRuntimeProviderCatalog",
      version: 1,
      entries: [{ id: "app", name: "@test/receipt-roots", version: "1.0.0" }],
      admissions: { app: { nodes: { "": { location: "", name: "@test/receipt-roots", version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} } } } },
    };
    for (const state of ["missing", "empty"]) {
      await context.test(`${state} roots refuse`, async () => {
        const release = await materializeNodeRuntimeProviderCatalog(catalog, join(root, state), {
          dependencyExportPolicy: "runtime-imports",
          runtimeEntrypoints: ["index.mjs"],
        });
        const entry = release.entries[0];
        const receiptPath = join(release.catalogDirectory, entry.releaseRelativePath, "release-receipt.json");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        if (state === "missing") delete receipt.runtimeEntrypoints;
        else receipt.runtimeEntrypoints = [];
        await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
        await assert.rejects(verifyNodeRuntimeReleaseCatalog(release.catalogDirectory), /runtime-imports requires explicit runtimeEntrypoints/u);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports distinguishes caught from finally-only missing requires", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-guarded-require-"));
  try {
    const catalogFor = async (id, source) => {
      const app = await npmTarball(root, `${id}.tgz`, {
        "package/package.json": JSON.stringify({ name: `@test/${id}`, version: "1.0.0", exports: "./index.cjs" }),
        "package/index.cjs": source,
      });
      return {
        type: "NodeRuntimeProviderCatalog",
        version: 1,
        entries: [{ id, name: `@test/${id}`, version: "1.0.0" }],
        admissions: { [id]: { nodes: { "": { location: "", name: `@test/${id}`, version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} } } } },
      };
    };
    await context.test("try-finally refuses", async () => {
      await assert.rejects(
        materializeNodeRuntimeProviderCatalog(await catalogFor("finally", 'try { require("missing-finally"); } finally {}\n'), join(root, "finally"), {
          dependencyExportPolicy: "runtime-imports",
          runtimeEntrypoints: ["index.cjs"],
        }),
        /runtime import closure is missing/u,
      );
    });
    await context.test("try-catch records guarded unavailable", async () => {
      const release = await materializeNodeRuntimeProviderCatalog(await catalogFor("caught", 'try { require("missing-caught"); } catch {}\n'), join(root, "caught"), {
        dependencyExportPolicy: "runtime-imports",
        runtimeEntrypoints: ["index.cjs"],
      });
      const entry = release.entries[0];
      const receipt = JSON.parse(await readFile(join(release.catalogDirectory, entry.releaseRelativePath, "release-receipt.json"), "utf8"));
      assert.deepEqual(receipt.guardedUnavailable, [{ dependency: "missing-caught", carrier: "index.cjs" }]);
      const verification = await verifyNodeRuntimeReleaseCatalog(release.catalogDirectory);
      assert.deepEqual(verification.entries[0].guardedUnavailable, [{ dependency: "missing-caught", carrier: "index.cjs" }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime-imports refuses to reuse an identical artifact under different roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-runtime-policy-reuse-"));
  try {
    const app = await npmTarball(root, "app.tgz", {
      "package/package.json": JSON.stringify({ name: "@test/policy-reuse", version: "1.0.0", type: "module", exports: "./index.mjs" }),
      "package/index.mjs": "export {};\n",
      "package/alternate.mjs": "export {};\n",
    });
    const catalog = {
      type: "NodeRuntimeProviderCatalog",
      version: 1,
      entries: [{ id: "app", name: "@test/policy-reuse", version: "1.0.0" }],
      admissions: { app: { nodes: { "": { location: "", name: "@test/policy-reuse", version: "1.0.0", integrity: app.integrity, tarballPath: app.path, edges: {} } } } },
    };
    await materializeNodeRuntimeProviderCatalog(catalog, join(root, "output"), {
      dependencyExportPolicy: "runtime-imports",
      runtimeEntrypoints: ["index.mjs"],
    });
    await assert.rejects(
      materializeNodeRuntimeProviderCatalog(catalog, join(root, "output"), {
        dependencyExportPolicy: "runtime-imports",
        runtimeEntrypoints: ["alternate.mjs"],
      }),
      /existing artifact receipt has a different runtime verification policy/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesces semantically identical normalized tarball members before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-release-tarball-dot-segments-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { immutable: "2.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    const manifest = JSON.stringify({ name: "immutable", version: "2.0.0" });
    const source = "module.exports = {};\n";
    const single = await npmTarball(root, "single.tgz", [
      ["package/package.json", manifest],
      ["package/dist/index.js", source],
    ]);
    const aliases = await Promise.all([
      npmTarball(root, "aliases-dot-first.tgz", [
        ["package/package.json", manifest],
        ["package/./dist/index.js", source],
        ["package/dist/index.js", source],
      ]),
      npmTarball(root, "aliases-canonical-first.tgz", [
        ["package/package.json", manifest],
        ["package/dist/index.js", source],
        ["package/./dist/index.js", source],
      ]),
    ]);
    const materialize = (tarball, outputRoot) => materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerTarballs: { immutable: { name: "immutable", version: "2.0.0", integrity: tarball.integrity, tarballPath: tarball.path } },
      outputRoot,
    });
    const releases = await Promise.all([
      materialize(single, join(root, "single")),
      ...aliases.map((tarball, index) => materialize(tarball, join(root, `aliases-${index}`))),
    ]);
    const extracted = await Promise.all(releases.map(async (release) => {
      const path = join(release.releaseDirectory, "app", "node_modules", "immutable", "dist", "index.js");
      return { bytes: await readFile(path), mode: (await stat(path)).mode & 0o777, artifactDigest: release.artifactDigest };
    }));
    assert.deepEqual(extracted, [extracted[0], extracted[0], extracted[0]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses conflicting normalized tarball aliases before extraction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "node-release-tarball-alias-conflict-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { immutable: "2.0.0" } }));
    await writeFile(join(app, "src", "server.mts"), "export {};\n");
    const manifest = JSON.stringify({ name: "immutable", version: "2.0.0" });
    const materialize = (tarball, output) => materializeNodeRuntimeRelease({
      entryPackageDirectory: app,
      providerTarballs: { immutable: { name: "immutable", version: "2.0.0", integrity: tarball.integrity, tarballPath: tarball.path } },
      outputRoot: join(root, output),
    });
    for (const [label, aliases] of [
      ["bytes", [["package/./dist/index.js", "first\n"], ["package/dist/index.js", "second\n"]]],
      ["mode", [["package/./dist/index.js", "same\n", 0o644], ["package/dist/index.js", "same\n", 0o600]]],
      ["type", [["package/./dist/index.js", "same\n"], ["package/dist/index.js", "", 0o644, "5"]]],
    ]) {
      await context.test(label, async () => {
        for (const [order, entries] of [["forward", aliases], ["reverse", [...aliases].reverse()]]) {
          const tarball = await npmTarball(root, `${label}-${order}.tgz`, [["package/package.json", manifest], ...entries]);
          await assert.rejects(materialize(tarball, `${label}-${order}`), /conflicting duplicate member dist\/index\.js/u);
        }
      });
    }
    const traversal = await npmTarball(root, "traversal.tgz", [
      ["package/package.json", manifest],
      ["package/../escaped", "nope\n"],
    ]);
    await assert.rejects(materialize(traversal, "traversal"), /traverses its package root/u);
    const link = await npmTarball(root, "link.tgz", [
      ["package/package.json", manifest],
      ["package/link", "", 0o777, "2"],
    ]);
    await assert.rejects(materialize(link, "link"), /unsupported type/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
