import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeJsnodeModuleEdges } from "../src/normalize-jsnode-module-edges.mjs";

test("articulates one relative cross-package import as a package edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsnode-module-edge-"));
  try {
    await mkdir(join(root, "provider/src"), { recursive: true });
    await mkdir(join(root, "consumer/src"), { recursive: true });
    await writeFile(join(root, "provider/src/value.mjs"), "export const value=1;\n");
    const result = await normalizeJsnodeModuleEdges({
      root, path: "consumer/src/index.mjs", source: "export { value } from '../../provider/src/value.mjs';\n",
      carriers: [
        { path: "provider/package.json", directory: "provider", name: "@owner/provider", version: "1.0.0", exports: "./src/index.mjs" },
        { path: "consumer/package.json", directory: "consumer", name: "@owner/consumer", version: "1.0.0" },
      ],
    });
    assert.equal(result.source, "export { value } from '@owner/provider/src/value.mjs';\n");
    assert.deepEqual(result.consumerDependencies, { "@owner/provider": "1.0.0" });
    assert.deepEqual(result.providerExports, [{ providerPath: "provider/package.json", exports: { ".": "./src/index.mjs", "./src/value.mjs": "./src/value.mjs" } }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
