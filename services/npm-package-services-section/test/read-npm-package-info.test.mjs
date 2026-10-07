import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readNpmPackageInfo } from "../scripts/read-npm-package-info.mjs";

async function fixture(context) {
  const path = await mkdtemp(join(tmpdir(), "npm-info-read-"));
  context.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, "package.json"), JSON.stringify({
    name: "@example/thing",
    version: "1.0.0",
    description: "A thing.",
    keywords: ["one", "two"],
  }));
  return {
    type: "NpmPackageInfoReadRequest",
    version: 1,
    directory: { type: "NpmPackageDirectory", version: 1, path },
    keys: ["name", "description", "keywords"],
  };
}

test("composes manifest reading and information projection", async (context) => {
  const request = await fixture(context);
  const read = await readNpmPackageInfo(request);
  assert.equal(read.path, join(request.directory.path, "package.json"));
  assert.equal(read.directory, request.directory);
  assert.deepEqual(read.info, {
    name: "@example/thing",
    description: "A thing.",
    keywords: ["one", "two"],
  });
  assert.ok(Object.isFrozen(read));
});

test("the command maps the same operation over NDJSON", async (context) => {
  const request = await fixture(context);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/read-npm-package-info.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = await once(child, "close");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), await readNpmPackageInfo(request));
});
