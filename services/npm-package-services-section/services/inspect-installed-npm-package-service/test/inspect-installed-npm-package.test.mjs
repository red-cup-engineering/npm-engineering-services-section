import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectInstalledNpmPackage } from "../scripts/inspect-installed-npm-package.mjs";

async function fixture(manifest, files) {
  const root = await mkdtemp(join(tmpdir(), "installed-npm-package-"));
  await writeFile(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

function request(root, name = "@customer/example") {
  return { type: "InstalledNpmPackageInspectionRequest", version: 1, packageRoot: root, expectedName: name, expectedVersion: "1.0.0", projectRoot: null };
}

test("reads a conformant installed package and its exact reachable import closure", async () => {
  const root = await fixture({ name: "@customer/example", version: "1.0.0", type: "module", exports: "./scripts/example.mjs", bin: { example: "scripts/example.mjs" } }, {
    "scripts/example.mjs": "#!/usr/bin/env node\nimport { value } from './value.mjs';\nexport const answer = value;\n",
    "scripts/value.mjs": "export const value = 42;\n",
    "scripts/unreachable.mjs": "export const unused = true;\n",
  });
  try {
    const read = await inspectInstalledNpmPackage(request(root));
    assert.equal(read.type, "InstalledNpmPackageInspectionRead");
    assert.equal(read.version, 1);
    assert.equal(read.javascriptFileCount, 3);
    assert.equal(read.reachableJavascriptFileCount, 2);
    assert.deepEqual(read.defects, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports identity, local dependency, absent face, syntax, and import defects", async () => {
  const root = await fixture({ name: "@customer/broken", version: "2.0.0", type: "module", exports: "./index.mjs", bin: { broken: "bad.mjs" }, types: "absent.d.ts", dependencies: { local: "file:../local" } }, {
    "index.mjs": "import './missing.mjs';\nimport undeclared from 'undeclared';\nexport default undeclared;\n",
    "bad.mjs": "export {\n",
  });
  try {
    const laws = (await inspectInstalledNpmPackage(request(root))).defects.map(({ law }) => law);
    assert.ok(laws.includes("installed-identity"));
    assert.ok(laws.includes("installed-local-dependency-protocol"));
    assert.ok(laws.includes("installed-face-target"));
    assert.ok(laws.includes("shipped-javascript-syntax"));
    assert.ok(laws.includes("runtime-import-resolution"));
    assert.ok(laws.includes("runtime-dependency-declaration"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not falsely refuse a real dependency whose exports map carries only an \"import\" condition", async () => {
  const root = await fixture({ name: "@customer/esm-consumer", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "@test/esm-only": "1.0.0" } }, {
    "index.mjs": "import { value } from '@test/esm-only';\nexport default value;\n",
    "node_modules/@test/esm-only/package.json": JSON.stringify({ name: "@test/esm-only", version: "1.0.0", type: "module", exports: { ".": { import: "./index.mjs" } } }),
    "node_modules/@test/esm-only/index.mjs": "export const value = 1;\n",
  });
  try {
    const laws = (await inspectInstalledNpmPackage(request(root, "@customer/esm-consumer"))).defects.map(({ law }) => law);
    assert.ok(!laws.includes("runtime-import-resolution"), JSON.stringify(laws));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses an inexact request before touching the filesystem", async () => {
  await assert.rejects(() => inspectInstalledNpmPackage({ ...request("/absent"), surprise: true }), /exactly/);
});
