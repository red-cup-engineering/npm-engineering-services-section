import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { projectNpmPackageInfo } from "../scripts/project-npm-package-info.mjs";

const request = {
  type: "NpmPackageInfoProjectionRequest",
  version: 1,
  manifest: {
    type: "NpmPackageManifest",
    version: 1,
    manifest: { name: "@example/thing", version: "1.0.0", description: "A thing.", keywords: ["one"] },
  },
  keys: ["name", "description", "keywords"],
};

test("projects only the explicitly requested manifest keys", () => {
  const projection = projectNpmPackageInfo(request);
  assert.deepEqual(projection.info, {
    name: "@example/thing",
    description: "A thing.",
    keywords: ["one"],
  });
  assert.equal(projection.manifest, request.manifest);
  assert.ok(Object.isFrozen(projection));
});

test("rejects requests that are not exact typed carriers", () => {
  assert.throws(() => projectNpmPackageInfo({ ...request, surprise: true }), /exact NpmPackageInfoProjectionRequest/u);
  assert.throws(() => projectNpmPackageInfo({ ...request, keys: ["name", "name"] }), /distinct/u);
});

test("the command maps the same operation over NDJSON", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/project-npm-package-info.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = await once(child, "close");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output), projectNpmPackageInfo(request));
});
