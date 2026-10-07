import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readNpmPackageSetInfo } from "../scripts/read-npm-package-set-info.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "npm-package-set-info-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  await writeFile(join(root, "a", "package.json"), JSON.stringify({ name: "a", description: "A", version: "1.0.0" }));
  await writeFile(join(root, "b", "package.json"), JSON.stringify({ name: "b", description: "B", keywords: ["bee"] }));
  return {
    type: "NpmPackageSetInfoReadRequest",
    version: 1,
    root,
    keys: ["name", "description", "keywords"],
    excludes: [],
  };
}

test("maps typed singular package-info reads across typed package directories", async (context) => {
  const request = await fixture(context);
  const read = await readNpmPackageSetInfo(request);
  assert.deepEqual(read.packages.map(({ info }) => info), [
    { name: "a", description: "A" },
    { name: "b", description: "B", keywords: ["bee"] },
  ]);
});

test("the command maps the same operation over NDJSON", async (context) => {
  const request = await fixture(context);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/read-npm-package-set-info.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = await once(child, "close");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), await readNpmPackageSetInfo(request));
});
