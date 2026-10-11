import assert from "node:assert/strict";
import test from "node:test";

import {
  assayPackageInstallResolution,
  classifyInstallResolutionFailure,
  dependencyResolutionInstallArguments,
  parseExactPackageSurface,
} from "../src/npm-package-install-resolution-assay.mjs";

test("requires exact package surfaces and installs with lifecycle scripts disabled", () => {
  assert.deepEqual(parseExactPackageSurface("@scope/package@1.2.3"), { surface: "@scope/package@1.2.3", name: "@scope/package", version: "1.2.3" });
  assert.throws(() => parseExactPackageSurface("@scope/package"), /exact npm package surface/u);
  assert.deepEqual(dependencyResolutionInstallArguments({ registryUrl: "http://registry.test/", surface: "@scope/package@1.2.3" }), [
    "install", "@scope/package@1.2.3", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry", "http://registry.test/",
  ]);
});

test("classifies resolution failure evidence without claiming runtime failure causes", () => {
  assert.equal(classifyInstallResolutionFailure({ stderr: "npm error code ETARGET\nNo matching version found" }), "target-version-unavailable");
  assert.equal(classifyInstallResolutionFailure({ stderr: "npm error code EUNSUPPORTEDPROTOCOL\nworkspace:*" }), "local-only-protocol");
  assert.equal(classifyInstallResolutionFailure({ stderr: "npm error code ERESOLVE\npeer dependency conflict" }), "peer-or-engine-resolution");
  assert.equal(classifyInstallResolutionFailure({ stderr: "npm error code EINTEGRITY\ntarball checksum failed" }), "tarball-retrieval-or-integrity");
  assert.equal(classifyInstallResolutionFailure({ code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }), "timed-out");
  assert.equal(classifyInstallResolutionFailure({ stderr: "network became a hedgehog" }), "other-resolution-failure");
});

test("uses isolated consumers, bounded concurrency, cleanup, and structured receipts", async () => {
  let active = 0;
  let maximumActive = 0;
  const cleaned = [];
  const calls = [];
  let consumerNumber = 0;
  const receipt = await assayPackageInstallResolution({
    packageSurfaces: ["@scope/ok@1.0.0", "@scope/missing@1.0.0", "@scope/workspace@1.0.0", "@scope/ok@1.0.0"],
    registryUrl: "http://registry.test/",
    concurrency: 2,
    timeoutMs: 1234,
    consumerFactory: async () => `/isolated/consumer-${consumerNumber++}`,
    cleanup: async (consumer) => { cleaned.push(consumer); },
    installImplementation: async (request) => {
      calls.push(request);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (request.arguments[1].includes("missing")) return { ok: false, stderr: "npm error code ETARGET" };
      if (request.arguments[1].includes("workspace")) return { ok: false, stderr: "npm error code EUNSUPPORTEDPROTOCOL\nworkspace:*" };
      return { ok: true, stdout: "added one package" };
    },
  });
  assert.equal(maximumActive <= 2, true);
  assert.equal(calls.length, 3);
  assert.equal(cleaned.length, 3);
  assert.deepEqual(receipt.summary, {
    attempted: 3,
    installed: 1,
    failed: 2,
    failuresByCategory: { "target-version-unavailable": 1, "local-only-protocol": 1 },
  });
  assert.equal(receipt.outcomes.find((outcome) => outcome.package.name === "@scope/ok").status, "installed");
  assert.match(receipt.claim, /does not establish runtime/u);
  assert.equal(calls.every((call) => call.arguments.includes("--ignore-scripts") && call.timeoutMs === 1234), true);
});

test("cleans up a temporary consumer after an installer throws", async () => {
  const cleaned = [];
  await assert.rejects(
    assayPackageInstallResolution({
      packageSurfaces: ["@scope/throws@1.0.0"],
      consumerFactory: async () => "/isolated/throwing-consumer",
      cleanup: async (consumer) => { cleaned.push(consumer); },
      installImplementation: async () => { throw new Error("spawn failure"); },
    }),
    /spawn failure/u,
  );
  assert.deepEqual(cleaned, ["/isolated/throwing-consumer"]);
});
