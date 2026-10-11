import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactDigest, materializeTracedNodeRuntime, verifyNodeRuntimeRelease } from "../src/materialize-release.mjs";

test("materializes an isolated JSNode closure with dynamic import and JSON assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "traced-node-runtime-"));
  try {
    const base = join(root, "app"), output = join(root, "runtime");
    await mkdir(join(base, "lib"), { recursive: true });
    await writeFile(join(base, "package.json"), '{"type":"module"}\n');
    await writeFile(join(base, "entry.mjs"), 'const module = await import("./lib/dynamic.mjs"); process.stdout.write(module.answer);\n');
    await writeFile(join(base, "lib", "dynamic.mjs"), 'import value from "./value.json" with { type: "json" }; export const answer = value.answer;\n');
    await writeFile(join(base, "lib", "value.json"), '{"answer":"relocated"}\n');
    const receipt = await materializeTracedNodeRuntime({ base, output, entrypoints: ["entry.mjs"] });
    assert.deepEqual(receipt.files, ["entry.mjs", "lib/dynamic.mjs", "lib/value.json", "package.json"]);
    assert.equal(receipt.fileCount, 4);
    assert.equal(await readFile(join(output, "package.json"), "utf8"), await readFile(join(base, "package.json"), "utf8"));
    assert.equal(await readFile(join(output, "lib", "value.json"), "utf8"), '{"answer":"relocated"}\n');
    const execution = spawnSync(process.execPath, [join(output, "entry.mjs")], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "relocated");
    assert.deepEqual(JSON.parse(await readFile(join(output, "release-receipt.json"), "utf8")), receipt);
    assert.equal((await verifyNodeRuntimeRelease(output)).ok, true);
    await writeFile(join(output, "lib", "value.json"), '{"answer":"changed"}\n');
    assert.equal((await verifyNodeRuntimeRelease(output)).ok, false);
    await rm(join(output, "lib", "dynamic.mjs"));
    const changed = await artifactDigest(output);
    await writeFile(join(output, "release-receipt.json"), JSON.stringify({ ...receipt, artifactDigest: changed.digest }));
    const missing = await verifyNodeRuntimeRelease(output);
    assert.equal(missing.ok, false);
    assert.ok(missing.unresolvedRuntimePackages.includes("./lib/dynamic.mjs"));
    await writeFile(join(output, "release-receipt.json"), JSON.stringify({ ...receipt, entrypoints: ["../outside.mjs"] }));
    await assert.rejects(verifyNodeRuntimeRelease(output), /relative entry paths/u);
    assert.rejects(materializeTracedNodeRuntime({ base, output, entrypoints: ["entry.mjs"] }), /output already exists/u);
    await assert.rejects(materializeTracedNodeRuntime({ base, output: join(base, "runtime"), entrypoints: ["entry.mjs"] }), /overlap/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses parent-symlink escapes and unresolved mandatory imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "traced-node-runtime-boundary-"));
  try {
    const base = join(root, "app"), outside = join(root, "outside");
    await mkdir(base, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(base, "package.json"), '{"type":"module"}\n');
    await writeFile(join(outside, "entry.mjs"), 'import("./missing.mjs");\n');
    await symlink(outside, join(base, "linked"));
    await assert.rejects(
      materializeTracedNodeRuntime({ base, output: join(root, "runtime"), entrypoints: ["linked/entry.mjs"] }),
      /carrier escapes its base/u,
    );

    await writeFile(join(base, "entry.mjs"), 'import("./missing.mjs");\n');
    await assert.rejects(
      materializeTracedNodeRuntime({ base, output: join(root, "refused-runtime"), entrypoints: ["entry.mjs"] }),
      (error) => error.code === "JSNODE_RUNTIME_CLOSURE_REFUSED" && error.obstructions[0].specifier === "./missing.mjs",
    );

    await mkdir(join(root, "output-link"));
    await symlink(base, join(root, "output-link", "inside"));
    await assert.rejects(
      materializeTracedNodeRuntime({ base, output: join(root, "output-link", "inside", "runtime"), entrypoints: ["entry.mjs"] }),
      /overlap/u,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
