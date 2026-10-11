import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { projectNpmPackageLockRegenerationCommand } from "../scripts/project-npm-package-lock-regeneration-command.mjs";

const request = {
  type: "NpmPackageLockRegenerationCommandProjectionRequest",
  version: 1,
  directory: { type: "NpmPackageDirectory", version: 1, path: "/work/package" },
  npmExecutable: "/bin/npm",
  offline: true,
};

test("projects an immutable shell-free npm package-lock command", () => {
  const command = projectNpmPackageLockRegenerationCommand(request);
  assert.deepEqual(command, {
    type: "NpmPackageLockRegenerationCommand",
    version: 1,
    command: "/bin/npm",
    arguments: ["install", "--package-lock-only", "--ignore-scripts", "--offline"],
    directory: "/work/package",
  });
  assert.equal(Object.isFrozen(command), true);
  assert.equal(Object.isFrozen(command.arguments), true);
});

test("refuses requests which leave execution policy implicit", () => {
  assert.throws(() => projectNpmPackageLockRegenerationCommand({ ...request, offline: undefined }), TypeError);
  assert.throws(() => projectNpmPackageLockRegenerationCommand({ ...request, extra: true }), TypeError);
});

test("the NDJSON command face maps the same operation over every request", () => {
  const requests = [request, { ...request, offline: false }];
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/project-npm-package-lock-regeneration-command.mjs", import.meta.url))],
    { input: serializeLines(requests), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseLines(result.stdout), requests.map(projectNpmPackageLockRegenerationCommand));
});
