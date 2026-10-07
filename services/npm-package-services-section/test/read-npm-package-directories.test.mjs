import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readNpmPackageDirectories } from "../scripts/read-npm-package-directories.mjs";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "npm-package-directories-read-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "nested", "b"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "a", "package.json"), "{}");
  await writeFile(join(root, "nested", "b", "package.json"), "{}");
  await writeFile(join(root, "node_modules", "ignored", "package.json"), "{}");
  return { type: "NpmPackageDirectoriesReadRequest", version: 1, root, excludes: ["node_modules"] };
}

test("reads typed package directories carrying regular package.json files", async (context) => {
  const request = await fixture(context);
  const read = await readNpmPackageDirectories(request);
  assert.deepEqual(read.directories, [
    { type: "NpmPackageDirectory", version: 1, path: join(request.root, "a") },
    { type: "NpmPackageDirectory", version: 1, path: join(request.root, "nested", "b") },
  ]);
  assert.ok(Object.isFrozen(read));
});

test("the command maps the same operation over NDJSON", async (context) => {
  const request = await fixture(context);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/read-npm-package-directories.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = await once(child, "close");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), await readNpmPackageDirectories(request));
});
