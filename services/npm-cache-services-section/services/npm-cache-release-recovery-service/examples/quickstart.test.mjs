import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { collectLockedReleases } from "@red-cup-engineering/npm-cache-release-recovery-service";

test("NPM-CACHE-QUICKSTART", () => {
  const integrity = "sha512-" + createHash("sha512").update("fixture").digest("base64");
  const releases = collectLockedReleases({ lockfileVersion: 3, packages: {
    "node_modules/widget": { version: "1.0.0", integrity, resolved: "https://registry.example/widget/-/widget-1.0.0.tgz" },
  } });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].name, "widget");
  assert.equal(releases[0].integrity, integrity);
});
