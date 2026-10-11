import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { catalogNodePackageSources } from "../src/catalog-node-package-sources.mjs";

test("projects one proof-carried current provider per package identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-package-source-catalog-"));
  try {
    const app = join(root, "app");
    const provider = join(root, "provider");
    await mkdir(app, { recursive: true });
    await mkdir(provider, { recursive: true });
    await mkdir(join(app, "node_modules", "@test"), { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "@test/app", version: "1.0.0", dependencies: { "@test/provider": "workspace:*" } }));
    await writeFile(join(provider, "package.json"), JSON.stringify({ name: "@test/provider", version: "2.0.0" }));
    await symlink(provider, join(app, "node_modules", "@test", "provider"));
    const receipt = await catalogNodePackageSources({ entryPackageDirectory: app });
    assert.deepEqual(receipt.packages.map(({ name }) => name), ["@test/app", "@test/provider"]);
    assert.match(receipt.packages[1].manifestEvidence, /^ni:\/\/\/sha-256;/u);
    assert.deepEqual(receipt.requests[0], { consumer: "@test/app", provider: "@test/provider", requested: "workspace:*", selected: "2.0.0" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("types an absent platform-conditional provider without weakening required closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-package-source-catalog-optional-"));
  try {
    const app = join(root, "app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), JSON.stringify({
      name: "@test/app",
      version: "1.0.0",
      optionalDependencies: { fsevents: "2.3.3" },
    }));
    const receipt = await catalogNodePackageSources({ entryPackageDirectory: app });
    assert.deepEqual(receipt.packages.map(({ name }) => name), ["@test/app"]);
    assert.deepEqual(receipt.optionalProviderAbsences, [{ consumer: "@test/app", provider: "fsevents", requested: "2.3.3" }]);

    await writeFile(join(app, "package.json"), JSON.stringify({
      name: "@test/app",
      version: "1.0.0",
      dependencies: { fsevents: "2.3.3" },
    }));
    await assert.rejects(
      catalogNodePackageSources({ entryPackageDirectory: app }),
      /runtime dependency fsevents requested by @test\/app has no observable provider source/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
