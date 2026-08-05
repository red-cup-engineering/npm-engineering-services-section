import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeJsnodePackageBody } from "../src/observe-jsnode-package-body.mjs";

test("observes named package carriers and their active source", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-body-observation-"));
  try {
    const carrier = join(root, "lib/emsenn/services/example");
    await mkdir(join(carrier, "src"), { recursive: true });
    await writeFile(join(carrier, "package.json"), '{"name":"@owner/example"}\n');
    await writeFile(join(carrier, "src/index.mjs"), "export {};\n");
    const observation = await observeJsnodePackageBody({ root });
    assert.equal(observation.packages.length, 1);
    assert.deepEqual(observation.sourceFiles, ["lib/emsenn/services/example/src/index.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
