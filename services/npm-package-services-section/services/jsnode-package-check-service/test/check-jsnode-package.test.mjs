import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkJsnodePackage } from "../src/check-jsnode-package.mjs";

async function writeManifest(dir, manifest) {
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("reports zero violations for a clean package", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-check-clean-"));
  try {
    const dir = join(root, "services", "example-widget-service");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeManifest(dir, {
      name: "@owner/example-widget-service",
      version: "0.1.0",
      private: true,
      type: "module",
      description: "Does one thing. Use it for that thing.",
      exports: "./src/example-widget.mjs",
      scripts: {
        check: "node --check src/example-widget.mjs",
        test: "node --test test/*.test.mjs",
        verify: "npm run check && npm test",
      },
      engines: { node: ">=22" },
    });
    await writeFile(join(dir, "src/example-widget.mjs"), 'export function exampleWidget() {\n  return Object.freeze({ type: "ExampleWidget" });\n}\n', "utf8");

    const report = await checkJsnodePackage({ directory: dir });
    assert.equal(report.type, "JsnodePackageCheckReport");
    assert.equal(report.layer, "services");
    assert.equal(report.packageKind, "jsnode");
    assert.equal(report.violationCount, 0, JSON.stringify(report.findings.filter((f) => f.status === "violation"), null, 2));
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.findings), true);
    assert.equal(Object.isFrozen(report.findings[0]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports multiple violations for a package that breaks several invariants", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-check-dirty-"));
  try {
    const dir = join(root, "services", "broken-widget-service");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeManifest(dir, {
      // M1: leaf "wrong-name" does not match directory "broken-widget-service"
      name: "@owner/wrong-name",
      // M2: private is not true
      private: false,
      type: "module",
      description: "Broken on purpose.",
      // M3: exports does not resolve to an existing file
      exports: "./src/missing.mjs",
      // M4: missing test and verify scripts
      scripts: { check: "node --check src/broken-widget.mjs" },
    });
    await writeFile(join(dir, "src/broken-widget.mjs"), "export function brokenWidget() {}\n", "utf8");

    const report = await checkJsnodePackage({ directory: dir });
    const byId = Object.fromEntries(report.findings.map((f) => [f.invariantId, f]));
    assert.equal(byId.M1.status, "violation");
    assert.equal(byId.M2.status, "violation");
    assert.equal(byId.M3.status, "violation");
    assert.equal(byId.M4.status, "violation");
    assert.ok(report.violationCount >= 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks dead-convention findings as informational and never as a violation", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-check-dead-"));
  try {
    const dir = join(root, "services", "example-widget-service");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeManifest(dir, {
      name: "@owner/example-widget-service",
      version: "0.1.0",
      private: true,
      type: "module",
      description: "Does one thing.",
      exports: "./src/example-widget.mjs",
      scripts: { check: "node --check src/example-widget.mjs", test: "node --test", verify: "npm run check && npm test" },
    });
    await writeFile(join(dir, "src/example-widget.mjs"), 'export function exampleWidget() {\n  return Object.freeze({ type: "ExampleWidget" });\n}\n', "utf8");

    const report = await checkJsnodePackage({ directory: dir });
    const deadFindings = report.findings.filter((f) => f.convention === "dead");
    assert.ok(deadFindings.length > 0);
    assert.ok(deadFindings.every((f) => f.status === "informational"));
    assert.ok(["D1", "M2b", "S1", "A1", "A2"].every((id) => deadFindings.some((f) => f.invariantId === id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a directory outside lib/apps/services/sites", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-check-layer-"));
  try {
    const dir = join(root, "somewhere-else", "example-widget-service");
    await mkdir(dir, { recursive: true });
    await writeManifest(dir, { name: "@owner/example-widget-service", private: true, type: "module" });
    await assert.rejects(() => checkJsnodePackage({ directory: dir }), /not under lib\/, apps\/, services\/, or sites\//u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a directory without a package.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-check-missing-"));
  try {
    const dir = join(root, "services", "no-manifest-service");
    await mkdir(dir, { recursive: true });
    await assert.rejects(() => checkJsnodePackage({ directory: dir }), /no package\.json/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
