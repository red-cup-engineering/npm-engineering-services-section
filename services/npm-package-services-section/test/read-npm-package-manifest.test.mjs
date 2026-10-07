import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readNpmPackageManifest } from "../scripts/read-npm-package-manifest.mjs";

async function fixture(context) {
  const path = await mkdtemp(join(tmpdir(), "npm-manifest-read-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, "package.json"), '{"name":"example","version":"1.0.0"}\n');
  return {
    type: "NpmPackageManifestReadRequest",
    version: 1,
    directory: { type: "NpmPackageDirectory", version: 1, path },
  };
}

test("reads the projected package.json and returns its admitted carrier", async (context) => {
  const request = await fixture(context);
  const read = await readNpmPackageManifest(request);
  assert.equal(read.path, join(request.directory.path, "package.json"));
  assert.equal(read.directory, request.directory);
  assert.equal(read.manifest.manifest.name, "example");
  assert.ok(Object.isFrozen(read));
});

test("the command maps the same operation over NDJSON", async (context) => {
  const request = await fixture(context);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/read-npm-package-manifest.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = await once(child, "close");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), await readNpmPackageManifest(request));
});
