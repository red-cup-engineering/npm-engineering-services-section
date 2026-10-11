import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClosureRefusal, committedClosureInstallArguments, installConsumerDependencyClosure, readCommittedDependencyLock } from "../src/install-consumer-dependency-closure.mjs";

test("closure installation uses npm ci and never the lock-mutating install command", () => {
  assert.deepEqual(committedClosureInstallArguments(), ["ci", "--no-audit", "--no-fund"]);
});

test("a consumer without a committed npm v2+ lock is refused before installation", async () => {
  const consumer = await mkdtemp(join(tmpdir(), "consumer-closure-"));
  await assert.rejects(
    () => readCommittedDependencyLock({ consumer }),
    (error) => error instanceof ClosureRefusal && error.refusal.law === "committed-dependency-closure",
  );
  await writeFile(join(consumer, "package-lock.json"), JSON.stringify({ lockfileVersion: 1 }), "utf8");
  await assert.rejects(
    () => readCommittedDependencyLock({ consumer }),
    (error) => error instanceof ClosureRefusal && /v2\+/.test(error.refusal.diagnostic),
  );
});

test("a committed npm lock supplies its graph identity", async () => {
  const consumer = await mkdtemp(join(tmpdir(), "consumer-closure-"));
  await writeFile(join(consumer, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/example": {} } }), "utf8");
  const lock = await readCommittedDependencyLock({ consumer });
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages, 2);
});

function registryResponse(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

async function consumerFixture() {
  const consumer = await mkdtemp(join(tmpdir(), "consumer-closure-"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "fixture-consumer", version: "1.0.0", type: "module",
    dependencies: { "@union/top": "1.0.0" },
  }), "utf8");
  await writeFile(join(consumer, "package-lock.json"), JSON.stringify({
    name: "fixture-consumer", lockfileVersion: 3, packages: {
      "": { name: "fixture-consumer", dependencies: { "@union/top": "1.0.0" } },
      "node_modules/@union/top": { name: "@union/top", version: "1.0.0" },
      "node_modules/@union/transitive": { name: "@union/transitive", version: "1.0.0" },
    },
  }), "utf8");
  return consumer;
}

function registryFetch(url) {
  const path = new URL(url).pathname;
  if (path.endsWith("/client.npmrc")) return registryResponse("@union:registry=https://registry.example/\n");
  if (path.endsWith("/%40union%2Ftop")) return registryResponse({ versions: { "1.0.0": {} } });
  return registryResponse({}, 404);
}

async function fixtureNpmCommand(consumer, { fail = false } = {}) {
  const command = join(consumer, "fixture-npm.mjs");
  const source = fail
    ? "#!/usr/bin/env node\\nprocess.stderr.write('simulated ci failure'); process.exit(9);\\n"
    : [
      "#!/usr/bin/env node", "import { mkdir, writeFile } from 'node:fs/promises';",
      "await mkdir('node_modules/@union/top',{recursive:true}); await mkdir('node_modules/@union/transitive',{recursive:true});",
      "await writeFile('node_modules/@union/top/package.json', JSON.stringify({name:'@union/top',version:'1.0.0',type:'module',exports:'./index.mjs'}));",
      "await writeFile('node_modules/@union/top/index.mjs', `export { value } from '@union/transitive';`);",
      "await writeFile('node_modules/@union/transitive/package.json', JSON.stringify({name:'@union/transitive',version:'1.0.0',type:'module',exports:'./index.mjs'}));",
      "await writeFile('node_modules/@union/transitive/index.mjs', `export const value='transitive';`);",
      "await writeFile('node_modules/.package-lock.json', JSON.stringify({lockfileVersion:3,packages:{'node_modules/@union/top':{name:'@union/top',version:'1.0.0'},'node_modules/@union/transitive':{name:'@union/transitive',version:'1.0.0'}}}));",
    ].join("\n");
  await writeFile(command, source, "utf8");
  await chmod(command, 0o755);
  return command;
}

test("committed closure preserves the lock and resolves a transitive local import", async () => {
  const consumer = await consumerFixture();
  const lockBefore = await readFile(join(consumer, "package-lock.json"), "utf8");
  const receipt = await installConsumerDependencyClosure({
    consumerPath: consumer, registryUrl: "https://registry.example/", fetchImplementation: registryFetch,
    npmCommand: await fixtureNpmCommand(consumer),
  });
  assert.equal(await readFile(join(consumer, "package-lock.json"), "utf8"), lockBefore);
  assert.equal(receipt.install.command.endsWith(" ci --no-audit --no-fund"), true);
  assert.equal(receipt.declaredImports[0].resolution, "resolved");
  const observed = await import(`${new URL(`file://${join(consumer, "node_modules/@union/top/index.mjs")}`).href}?fixture=1`);
  assert.equal(observed.value, "transitive");
});

test("failed committed closure restores pre-existing consumer npm configuration", async () => {
  const consumer = await consumerFixture();
  await writeFile(join(consumer, ".npmrc"), "registry=https://before.example/\n", "utf8");
  const npmCommand = await fixtureNpmCommand(consumer, { fail: true });
  await assert.rejects(() => installConsumerDependencyClosure({
    consumerPath: consumer, registryUrl: "https://registry.example/", fetchImplementation: registryFetch,
    npmCommand,
  }), (error) => error instanceof ClosureRefusal && error.refusal.law === "installation");
  assert.equal(await readFile(join(consumer, ".npmrc"), "utf8"), "registry=https://before.example/\n");
});
