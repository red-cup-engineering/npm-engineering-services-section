import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { regeneratePackageLock } from "../scripts/regenerate-package-lock.mjs";

test("regeneratePackageLock previews and generates package-lock.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "regenerate-package-lock-"));
  try {
    await writeFile(join(directory, "package.json"), '{"name":"fixture","version":"1.0.0","private":true}\n');
    const preview = regeneratePackageLock({ directory });
    assert.equal(preview.apply, false);
    await assert.rejects(access(join(directory, "package-lock.json")));

    const result = regeneratePackageLock({ directory, apply: true, offline: true });
    assert.equal(result.completed, true);
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
    assert.equal(lock.name, "fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
