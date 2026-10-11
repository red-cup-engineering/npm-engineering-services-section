import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClosureRefusal, installConsumerDependencyClosure } from "../src/install-consumer-dependency-closure.mjs";

// Exercise the public installer and its real child-Node resolver. Only npm and
// registry I/O are fixtures; dependency modules must never be evaluated.
async function withConsumer(t, { exports = "./index.mjs", main, target = "file", priorNpmrc = null }, run) {
  const consumer = await mkdtemp(join(tmpdir(), "consumer import resolution "));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const packagePath = join(consumer, "node_modules", "example");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "fixture-consumer", type: "module", dependencies: { example: "1.0.0" },
  }));
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    "": { dependencies: { example: "1.0.0" } },
    "node_modules/example": { version: "1.0.0" },
  } });
  await writeFile(join(consumer, "package-lock.json"), lock);
  await writeFile(join(consumer, "node_modules", ".package-lock.json"), lock);
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "example", version: "1.0.0", type: "module", exports, main,
  }));
  if (target === "directory") await mkdir(join(packagePath, "index.mjs"));
  if (target === "file" || target === "symlink") {
    const file = target === "symlink" ? "actual.mjs" : "index.mjs";
    await writeFile(join(packagePath, file), "throw new Error('dependency evaluation is forbidden');\n");
    if (target === "symlink") await symlink("actual.mjs", join(packagePath, "index.mjs"));
  }
  if (priorNpmrc !== null) await writeFile(join(consumer, ".npmrc"), priorNpmrc);
  const npmCommand = join(consumer, "fixture-npm.mjs");
  await writeFile(npmCommand, [
    "#!/usr/bin/env node",
    "import assert from 'node:assert/strict';",
    "assert.deepEqual(process.argv.slice(2), ['ci', '--no-audit', '--no-fund']);",
  ].join("\n"));
  await chmod(npmCommand, 0o755);
  await run(() => installConsumerDependencyClosure({
    consumerPath: consumer, npmCommand, registryUrl: "https://registry.example/",
    fetchImplementation: () => new Response("@union:registry=https://registry.example/\n"),
  }), consumer);
  assert.equal(await readFile(join(consumer, "package-lock.json"), "utf8"), lock);
}

for (const [label, options] of [
  ["missing export target", { target: "missing" }],
  ["directory export target", { target: "directory" }],
  ["missing legacy main target", { exports: null, main: "./absent.mjs", target: "missing" }],
  ["missing import condition despite a present require target", { exports: { import: "./absent.mjs", require: "./index.mjs" } }],
]) {
  test(`${label} produces an import-resolution refusal and restores npm configuration`, async (t) => {
    const priorNpmrc = "# original consumer settings\n";
    await withConsumer(t, { ...options, priorNpmrc }, async (install, consumer) => {
      await assert.rejects(install, (error) => {
        assert.ok(error instanceof ClosureRefusal);
        assert.equal(error.refusal.law, "import-resolution");
        assert.equal(error.refusal.defects.length, 1);
        const [defect] = error.refusal.defects;
        assert.deepEqual({ name: defect.name, kind: defect.kind, spec: defect.spec }, {
          name: "example", kind: "dependency", spec: "1.0.0",
        });
        assert.equal(typeof defect.diagnostic, "string");
        assert.ok(defect.diagnostic.length > 0);
        return true;
      });
      assert.equal(await readFile(join(consumer, ".npmrc"), "utf8"), priorNpmrc);
    });
  });
}

test("missing export target removes newly created npm configuration on refusal", async (t) => {
  await withConsumer(t, { target: "missing" }, async (install, consumer) => {
    await assert.rejects(install, (error) => error instanceof ClosureRefusal && error.refusal.law === "import-resolution");
    await assert.rejects(readFile(join(consumer, ".npmrc")), { code: "ENOENT" });
  });
});

for (const target of ["file", "symlink"]) {
  test(`an existing ${target} target resolves without executing dependency code`, async (t) => {
    await withConsumer(t, { target }, async (install) => {
      const receipt = await install();
      assert.equal(receipt.type, "ConsumerDependencyClosureReceipt");
      assert.equal(receipt.declaredImports[0].resolution, "resolved");
    });
  });
}

test("a deliberately unexported package root retains its existing receipt classification", async (t) => {
  await withConsumer(t, { exports: { "./feature": "./index.mjs" } }, async (install) => {
    const receipt = await install();
    assert.equal(receipt.declaredImports[0].resolution, "resolved-unexported-root");
  });
});
