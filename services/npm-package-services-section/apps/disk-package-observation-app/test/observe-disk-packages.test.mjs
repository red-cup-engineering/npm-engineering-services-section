import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { observeDiskPackages } from "../src/observe-disk-packages.mjs";

async function fixtureTree() {
  const root = await mkdtemp(join(tmpdir(), "disk-package-observation-"));
  await mkdir(join(root, "good-package"), { recursive: true });
  await writeFile(
    join(root, "good-package", "package.json"),
    JSON.stringify({ name: "@example/good-package", version: "1.2.3", private: true }),
  );
  await mkdir(join(root, "broken-package"), { recursive: true });
  await writeFile(join(root, "broken-package", "package.json"), "{not json");
  await mkdir(join(root, "nameless-package"), { recursive: true });
  await writeFile(join(root, "nameless-package", "package.json"), JSON.stringify({ version: "0.0.1" }));
  await mkdir(join(root, "node_modules", "decoy"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "decoy", "package.json"),
    JSON.stringify({ name: "decoy", version: "9.9.9" }),
  );
  await writeFile(join(root, "good-package", "index.mjs"), "export {};\n");
  return root;
}

test("observes packages, reports defects, honors excludes", async () => {
  const root = await fixtureTree();
  try {
    const observation = await observeDiskPackages({ root, excludes: ["node_modules"] });
    assert.equal(observation.type, "DiskPackageObservation");
    assert.deepEqual(
      observation.packages.map(({ name, version, path, private: isPrivate }) => ({ name, version, path, private: isPrivate })),
      [{ name: "@example/good-package", version: "1.2.3", path: "good-package/package.json", private: true }],
    );
    assert.equal(observation.defects.length, 2);
    assert.match(observation.defects[0].reason, /unparseable manifest/u);
    assert.equal(observation.defects[1].reason, "manifest has no name");
    assert.ok(observation.slices.mjs.count >= 1);
    assert.ok(Object.isFrozen(observation) && Object.isFrozen(observation.packages));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excluded decoy package never appears even without defects", async () => {
  const root = await fixtureTree();
  try {
    await rm(join(root, "broken-package"), { recursive: true });
    await rm(join(root, "nameless-package"), { recursive: true });
    const observation = await observeDiskPackages({ root, excludes: ["node_modules"] });
    assert.deepEqual(observation.packages.map((entry) => entry.name), ["@example/good-package"]);
    assert.equal(observation.defects.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
