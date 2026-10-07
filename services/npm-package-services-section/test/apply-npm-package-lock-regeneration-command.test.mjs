import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { applyNpmPackageLockRegenerationCommand } from "../scripts/apply-npm-package-lock-regeneration-command.mjs";

test("applies exactly the admitted command through both program faces", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "apply-package-lock-command-"));
  try {
    const firstDirectory = join(fixture, "first");
    const secondDirectory = join(fixture, "second");
    const executable = join(fixture, "fake-npm.mjs");
    await Promise.all([
      mkdir(firstDirectory),
      mkdir(secondDirectory),
    ]);
    await writeFile(
      executable,
      '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync("package-lock.json", JSON.stringify({ arguments: process.argv.slice(2) }));\n',
    );
    await chmod(executable, 0o755);

    const command = {
      type: "NpmPackageLockRegenerationCommand",
      version: 1,
      command: executable,
      arguments: ["install", "--package-lock-only", "--ignore-scripts", "--offline"],
      directory: firstDirectory,
    };
    const receipt = applyNpmPackageLockRegenerationCommand(command);
    assert.equal(receipt.type, "NpmPackageLockRegenerationCommandApplicationReceipt");
    assert.equal(receipt.version, 1);
    assert.deepEqual(receipt.command, command);
    assert.equal(receipt.execution.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(firstDirectory, "package-lock.json"), "utf8")), { arguments: command.arguments });

    const commanded = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/apply-npm-package-lock-regeneration-command.mjs", import.meta.url))],
      { input: serializeLines([{ ...command, directory: secondDirectory }]), encoding: "utf8" },
    );
    assert.equal(commanded.status, 0, commanded.stderr);
    const [commandReceipt] = parseLines(commanded.stdout);
    assert.equal(commandReceipt.type, receipt.type);
    assert.equal(commandReceipt.version, receipt.version);
    assert.equal(commandReceipt.execution.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(secondDirectory, "package-lock.json"), "utf8")), { arguments: command.arguments });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("refuses an arbitrary executable command wearing the carrier name", () => {
  assert.throws(
    () => applyNpmPackageLockRegenerationCommand({
      type: "NpmPackageLockRegenerationCommand",
      version: 1,
      command: "npm",
      arguments: ["publish"],
      directory: "/work/package",
    }),
    TypeError,
  );
});
