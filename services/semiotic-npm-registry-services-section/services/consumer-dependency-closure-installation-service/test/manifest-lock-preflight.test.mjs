import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClosureRefusal, installConsumerDependencyClosure, readCommittedDependencyLock } from "../src/install-consumer-dependency-closure.mjs";

const semantic = "@red-cup-engineering/semantic-content-identify-service";
const ni = "@red-cup-engineering/ni-uri-services-section";
const fixtures = new URL("./fixtures/consumer-lock-disagreement/", import.meta.url);

async function withConsumer(run) {
  const consumer = await mkdtemp(join(tmpdir(), "manifest-lock-preflight-"));
  try { await run(consumer); }
  finally { await rm(consumer, { recursive: true, force: true }); }
}

async function writeFixture(consumer, manifest, packages) {
  await writeFile(join(consumer, "package.json"), JSON.stringify(manifest));
  await writeFile(join(consumer, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}

async function requireEarlyRefusal(consumer, expectedNames) {
  const before = await Promise.all(["package.json", "package-lock.json"].map((file) => readFile(join(consumer, file), "utf8")));
  await writeFile(join(consumer, ".npmrc"), "# retained consumer configuration\n");
  let fetchCalls = 0;
  let refusal;
  await assert.rejects(() => installConsumerDependencyClosure({
    consumerPath: consumer,
    registryUrl: "https://offline.invalid/",
    npmCommand: join(consumer, "MUST-NOT-RUN"),
    fetchImplementation: () => { fetchCalls += 1; throw new Error("network must not be reached"); },
  }), (error) => {
    assert.ok(error instanceof ClosureRefusal);
    refusal = error.refusal;
    assert.equal(refusal.law, "committed-dependency-closure");
    assert.deepEqual(refusal.defects.map(({ name }) => name), expectedNames);
    return true;
  });
  assert.equal(fetchCalls, 0);
  assert.equal(await readFile(join(consumer, ".npmrc"), "utf8"), "# retained consumer configuration\n");
  assert.deepEqual(await Promise.all(["package.json", "package-lock.json"].map((file) => readFile(join(consumer, file), "utf8"))), before);
  assert.deepEqual((await readdir(consumer)).sort(), [".npmrc", "package-lock.json", "package.json"]);
  return refusal;
}

for (const [consumerName, names] of [["koios", [semantic]], ["activitypub", [ni, semantic]]]) {
  test(`exact ${consumerName} source is diagnosed before registry discovery or installation`, async () => {
    await withConsumer(async (consumer) => {
      for (const file of ["package.json", "package-lock.json"]) {
        await copyFile(new URL(`${consumerName}/${file}`, fixtures), join(consumer, file));
      }
      const refusal = await requireEarlyRefusal(consumer, names);
      const mismatch = refusal.defects.find(({ name }) => name === semantic);
      assert.equal(mismatch.spec, "0.2.2");
      assert.equal(mismatch.lockedSpec, "0.2.1");
      assert.equal(mismatch.lockedVersion, "0.2.1");
      assert.equal(mismatch.reason, "exact-version-mismatch");
      if (consumerName === "activitypub") {
        const missing = refusal.defects.find(({ name }) => name === ni);
        assert.equal(missing.spec, "0.1.1");
        assert.equal(missing.lockedVersion, null);
        assert.equal(missing.reason, "locked-package-absent");
      }
    });
  });
}

test("aligned exact runtime pins pass the read-only preflight", async () => {
  await withConsumer(async (consumer) => {
    const manifest = { dependencies: { example: "1.2.3" } };
    await writeFixture(consumer, manifest, { "": { dependencies: { example: "1.2.3" } }, "node_modules/example": { version: "1.2.3" } });
    const lock = await readCommittedDependencyLock({ consumer, manifest });
    assert.equal(lock.packages, 2);
  });
});

test("matching root declarations do not hide a mismatched locked exact version", async () => {
  await withConsumer(async (consumer) => {
    const manifest = { dependencies: { example: "1.2.3" } };
    await writeFixture(consumer, manifest, { "": { dependencies: { example: "1.2.3" } }, "node_modules/example": { version: "1.2.2" } });
    const refusal = await requireEarlyRefusal(consumer, ["example"]);
    assert.equal(refusal.defects[0].lockedSpec, "1.2.3");
    assert.equal(refusal.defects[0].lockedVersion, "1.2.2");
  });
});

for (const [name, manifest, packages] of [
  ["semver ranges", { dependencies: { example: "^1.2.0" } }, { "node_modules/example": { version: "1.3.0" } }],
  ["equivalent root spec metadata", { dependencies: { example: "1.2.3" } }, { "": { dependencies: { example: "^1.2.0" } }, "node_modules/example": { version: "1.2.3" } }],
  ["optional override", { dependencies: { example: "1.2.3" }, optionalDependencies: { example: "1.2.4" } }, {}],
  ["accepted alternate version", { dependencies: { example: "1.2.3" }, acceptDependencies: { example: "2.0.0" } }, { "node_modules/example": { version: "2.0.0" } }],
  ["build metadata equivalence", { dependencies: { example: "1.2.3" } }, { "node_modules/example": { version: "1.2.3+build" } }],
  ["prerelease versions", { dependencies: { example: "1.2.3-beta.1" } }, { "node_modules/example": { version: "1.2.3-beta.1" } }],
  ["npm aliases", { dependencies: { example: "npm:other@1.2.3" } }, { "node_modules/example": { version: "1.2.3" } }],
  ["local file specifications", { dependencies: { example: "file:../example" } }, { "node_modules/example": { link: true, resolved: "../example" } }],
  ["git specifications", { dependencies: { example: "git+https://example.invalid/example.git#main" } }, { "node_modules/example": { version: "1.2.3" } }],
  ["noncanonical declared version", { dependencies: { example: "01.2.3" } }, { "node_modules/example": { version: "1.2.3" } }],
  ["noncanonical locked version", { dependencies: { example: "1.2.3" } }, { "node_modules/example": { version: "01.2.3" } }],
  ["dev overlap", { dependencies: { example: "1.2.3" }, devDependencies: { example: "1.2.4" } }, { "node_modules/example": { version: "1.2.4" } }],
  ["workspace links", { dependencies: { example: "1.2.3" } }, { "node_modules/example": { link: true, resolved: "packages/example" }, "packages/example": { version: "1.2.3" } }],
  ["workspace specifiers", { dependencies: { example: "workspace:*" } }, { "node_modules/example": { link: true, resolved: "packages/example" } }],
  ["optional peer absence", { peerDependencies: { example: "1.2.3" }, peerDependenciesMeta: { example: { optional: true } } }, {}],
  ["consumer package version metadata drift", { version: "1.0.9", dependencies: { example: "1.2.3" } }, { "": { version: "1.0.7" }, "node_modules/example": { version: "1.2.3" } }],
]) {
  test(`${name} stays with npm ci rather than overbroad string equality`, async () => {
    await withConsumer(async (consumer) => {
      await writeFixture(consumer, manifest, { "": {}, ...packages });
      await readCommittedDependencyLock({ consumer, manifest });
    });
  });
}

test("a missing required exact package is refused without creating npm configuration", async () => {
  await withConsumer(async (consumer) => {
    const manifest = { dependencies: { example: "1.2.3" } };
    await writeFixture(consumer, manifest, { "": { dependencies: { example: "1.2.3" } } });
    let fetchCalls = 0;
    await assert.rejects(() => installConsumerDependencyClosure({
      consumerPath: consumer, npmCommand: join(consumer, "MUST-NOT-RUN"),
      fetchImplementation: () => { fetchCalls += 1; throw new Error("must not fetch"); },
    }), (error) => error instanceof ClosureRefusal
      && error.refusal.law === "committed-dependency-closure"
      && error.refusal.defects[0].reason === "locked-package-absent");
    assert.equal(fetchCalls, 0);
    assert.deepEqual((await readdir(consumer)).sort(), ["package-lock.json", "package.json"]);
  });
});

test("a v2 lock cannot satisfy a direct pin with only another package's nested dependency", async () => {
  await withConsumer(async (consumer) => {
    const manifest = { dependencies: { example: "1.2.3" } };
    await writeFile(join(consumer, "package.json"), JSON.stringify(manifest));
    await writeFile(join(consumer, "package-lock.json"), JSON.stringify({
      lockfileVersion: 2, packages: {
        "": { dependencies: { example: "1.2.3" } },
        "node_modules/other/node_modules/example": { version: "1.2.3" },
      },
    }));
    const refusal = await requireEarlyRefusal(consumer, ["example"]);
    assert.equal(refusal.defects[0].reason, "locked-package-absent");
  });
});

test("a present npm shrinkwrap defers the early check instead of diagnosing the ignored package-lock", async () => {
  await withConsumer(async (consumer) => {
    const manifest = { dependencies: { example: "1.2.3" } };
    await writeFixture(consumer, manifest, { "": {}, "node_modules/example": { version: "1.2.2" } });
    const shrinkwrap = JSON.stringify({ lockfileVersion: 3, packages: {
      "": { dependencies: { example: "1.2.3" } },
      "node_modules/example": { version: "1.2.3" },
    } });
    await writeFile(join(consumer, "npm-shrinkwrap.json"), shrinkwrap);
    await readCommittedDependencyLock({ consumer, manifest });
    let fetchCalls = 0;
    await assert.rejects(() => installConsumerDependencyClosure({
      consumerPath: consumer, npmCommand: join(consumer, "MUST-NOT-RUN"),
      fetchImplementation: () => { fetchCalls += 1; throw new Error("offline sentinel"); },
    }), (error) => error instanceof ClosureRefusal && error.refusal.law === "registry-unreachable");
    assert.equal(fetchCalls, 1);
    assert.equal(await readFile(join(consumer, "npm-shrinkwrap.json"), "utf8"), shrinkwrap);
    assert.deepEqual((await readdir(consumer)).sort(), ["npm-shrinkwrap.json", "package-lock.json", "package.json"]);
  });
});
