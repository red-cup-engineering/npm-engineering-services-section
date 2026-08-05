import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scaffoldJsnodePackage } from "../src/scaffold-jsnode-package.mjs";

test("constructs a services-layer package.json field-by-field without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jsnode-scaffold-"));
  try {
    const result = await scaffoldJsnodePackage({
      name: "example-widget-service",
      owner: "red-cup-engineering",
      directory,
      layer: "services",
      description: "Does one thing. Use it for that thing.",
    });
    assert.equal(result.type, "JsnodePackageScaffoldConstruction");
    assert.equal(result.applied, false);
    assert.equal(result.packageDir, join(directory, "services", "example-widget-service"));
    assert.deepEqual(result.manifest, {
      name: "@red-cup-engineering/example-widget-service",
      version: "0.1.0",
      private: true,
      type: "module",
      description: "Does one thing. Use it for that thing.",
      exports: "./src/example-widget.mjs",
      scripts: {
        clean: "rm -rf .tmp",
        check: "node --check src/example-widget.mjs",
        build: "node --check src/example-widget.mjs",
        test: "node --test test/*.test.mjs",
        verify: "npm run check && npm test",
      },
      engines: { node: ">=22" },
    });
    assert.equal(result.files.length, 3);
    assert.deepEqual(result.files.map((file) => file.path), [
      "package.json",
      "src/example-widget.mjs",
      "test/example-widget.test.mjs",
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.manifest), true);
    assert.equal(existsSync(result.packageDir), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("adds a bin field and bin script check for the apps layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jsnode-scaffold-"));
  try {
    const result = await scaffoldJsnodePackage({
      name: "example-widget-app",
      owner: "red-cup-engineering",
      directory,
      layer: "apps",
      description: "Composes services. Use it to compose them.",
    });
    assert.equal(result.manifest.bin["example-widget-app"], "./bin/example-widget.mjs");
    assert.equal(result.manifest.scripts.check, "node --check src/example-widget.mjs && node --check bin/example-widget.mjs");
    assert.deepEqual(result.files.map((file) => file.path), [
      "package.json",
      "src/example-widget.mjs",
      "test/example-widget.test.mjs",
      "bin/example-widget.mjs",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("apply:true writes the package skeleton to disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jsnode-scaffold-"));
  try {
    const result = await scaffoldJsnodePackage({
      name: "example-widget-service",
      owner: "red-cup-engineering",
      directory,
      layer: "services",
      description: "Does one thing. Use it for that thing.",
      apply: true,
    });
    assert.equal(result.applied, true);
    const manifestText = await readFile(join(result.packageDir, "package.json"), "utf8");
    assert.deepEqual(JSON.parse(manifestText), result.manifest);
    const srcText = await readFile(join(result.packageDir, "src/example-widget.mjs"), "utf8");
    assert.match(srcText, /export function exampleWidget\(\)/u);
    const testText = await readFile(join(result.packageDir, "test/example-widget.test.mjs"), "utf8");
    assert.match(testText, /from "..\/src\/example-widget.mjs"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing package directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jsnode-scaffold-"));
  try {
    const options = {
      name: "example-widget-service",
      owner: "red-cup-engineering",
      directory,
      layer: "services",
      description: "Does one thing. Use it for that thing.",
      apply: true,
    };
    await scaffoldJsnodePackage(options);
    await assert.rejects(() => scaffoldJsnodePackage(options), /already exists/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses absent or invalid scaffold material", async () => {
  await assert.rejects(() => scaffoldJsnodePackage(), /name/u);
  await assert.rejects(() => scaffoldJsnodePackage({ name: "Bad Name", owner: "x", directory: "/tmp", description: "d." }), /lower-kebab-case/u);
  await assert.rejects(() => scaffoldJsnodePackage({ name: "widget-service", owner: "Bad Owner", directory: "/tmp", description: "d." }), /owner/u);
  await assert.rejects(() => scaffoldJsnodePackage({ name: "widget-service", owner: "x", directory: "/tmp", layer: "nowhere", description: "d." }), /layer/u);
});
