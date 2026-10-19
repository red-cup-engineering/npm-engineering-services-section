import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyResolvedUrl,
  findPackageLockFiles,
  parseRegistryTarballUrl,
  rewritePackageLockText,
} from "../scripts/repoint-set-of-package-locks.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/repoint-set-of-package-locks.mjs", import.meta.url));

function lockfileText(resolvedLines) {
  return [
    "{",
    '  "name": "fixture",',
    '  "version": "1.0.0",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    ...resolvedLines,
    "  }",
    "}",
    "",
  ].join("\n");
}

test("classifies house-scoped and non-house dead-host URLs", () => {
  assert.deepEqual(
    classifyResolvedUrl("http://127.0.0.1:4873/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz"),
    { deadHost: true, houseScoped: true, misrouted: false, url: "https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz" },
  );
  assert.deepEqual(
    classifyResolvedUrl("http://127.0.0.1:4873/lodash/-/lodash-4.17.21.tgz"),
    { deadHost: true, houseScoped: false, misrouted: false, url: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" },
  );
});

test("classifies a non-house package misrouted through registry.561.group", () => {
  assert.deepEqual(
    classifyResolvedUrl("https://registry.561.group/chalk/-/chalk-5.3.0.tgz"),
    { deadHost: false, houseScoped: false, misrouted: true, url: "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz" },
  );
  assert.deepEqual(
    classifyResolvedUrl("https://registry.561.group/@babel/runtime/-/runtime-7.24.0.tgz"),
    { deadHost: false, houseScoped: false, misrouted: true, url: "https://registry.npmjs.org/@babel/runtime/-/runtime-7.24.0.tgz" },
  );
});

test("leaves already-correct hosts unclassified", () => {
  assert.deepEqual(
    classifyResolvedUrl("https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz"),
    { deadHost: false, houseScoped: true, misrouted: false, url: null },
  );
  assert.deepEqual(
    classifyResolvedUrl("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"),
    { deadHost: false, houseScoped: false, misrouted: false, url: null },
  );
  assert.deepEqual(classifyResolvedUrl(""), { deadHost: false, houseScoped: false, misrouted: false, url: null });
  assert.deepEqual(classifyResolvedUrl("not a url"), { deadHost: false, houseScoped: false, misrouted: false, url: null });
});

test("rewrites a house-scoped package resolved through the laptop verdaccio cache", () => {
  const before = lockfileText([
    '    "node_modules/@red-cup-engineering/eavt-services-section": {',
    '      "version": "0.5.0",',
    '      "resolved": "http://127.0.0.1:4873/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",',
    '      "integrity": "sha512-deadbeef=="',
    "    }",
  ]);
  const { output, rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, [{
    from: "http://127.0.0.1:4873/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",
    to: "https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",
  }]);
  assert.match(output, /"resolved": "https:\/\/registry\.561\.group\/@red-cup-engineering\/eavt-services-section\/-\/eavt-services-section-0\.5\.0\.tgz"/);
  assert.match(output, /"integrity": "sha512-deadbeef=="/);
});

test("rewrites a non-house package resolved through the laptop verdaccio cache to the public registry", () => {
  const before = lockfileText([
    '    "node_modules/lodash": {',
    '      "version": "4.17.21",',
    '      "resolved": "http://127.0.0.1:4873/lodash/-/lodash-4.17.21.tgz",',
    '      "integrity": "sha512-cafef00d=="',
    "    }",
  ]);
  const { output, rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, [{
    from: "http://127.0.0.1:4873/lodash/-/lodash-4.17.21.tgz",
    to: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  }]);
  assert.match(output, /"resolved": "https:\/\/registry\.npmjs\.org\/lodash\/-\/lodash-4\.17\.21\.tgz"/);
  assert.match(output, /"integrity": "sha512-cafef00d=="/);
});

test("rewrites localhost with an explicit port and the GCP mirror VM with an explicit port", () => {
  const before = lockfileText([
    '    "node_modules/@emsenn/one": {',
    '      "resolved": "http://localhost:4873/@emsenn/one/-/one-1.0.0.tgz",',
    '      "integrity": "sha512-aaa=="',
    "    },",
    '    "node_modules/@emsenn/two": {',
    '      "resolved": "http://34.61.173.187:4873/@emsenn/two/-/two-2.0.0.tgz",',
    '      "integrity": "sha512-bbb=="',
    "    }",
  ]);
  const { rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, [
    { from: "http://localhost:4873/@emsenn/one/-/one-1.0.0.tgz", to: "https://registry.561.group/@emsenn/one/-/one-1.0.0.tgz" },
    { from: "http://34.61.173.187:4873/@emsenn/two/-/two-2.0.0.tgz", to: "https://registry.561.group/@emsenn/two/-/two-2.0.0.tgz" },
  ]);
});

test("rewrites a run.app host regardless of subdomain", () => {
  const before = lockfileText([
    '    "node_modules/@coesite-operations/widget": {',
    '      "resolved": "https://npm-mirror-abc123-uc.a.run.app/@coesite-operations/widget/-/widget-3.1.4.tgz",',
    '      "integrity": "sha512-ccc=="',
    "    }",
  ]);
  const { rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, [{
    from: "https://npm-mirror-abc123-uc.a.run.app/@coesite-operations/widget/-/widget-3.1.4.tgz",
    to: "https://registry.561.group/@coesite-operations/widget/-/widget-3.1.4.tgz",
  }]);
});

test("rewrites a non-house package misrouted through registry.561.group to the public registry, leaving a correctly-hosted house package alone", () => {
  const before = lockfileText([
    '    "node_modules/@red-cup-engineering/eavt-services-section": {',
    '      "resolved": "https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",',
    '      "integrity": "sha512-deadbeef=="',
    "    },",
    '    "node_modules/chalk": {',
    '      "resolved": "https://registry.561.group/chalk/-/chalk-5.3.0.tgz",',
    '      "integrity": "sha512-feedface=="',
    "    }",
  ]);
  const { output, rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, [{
    from: "https://registry.561.group/chalk/-/chalk-5.3.0.tgz",
    to: "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz",
  }]);
  assert.match(output, /"resolved": "https:\/\/registry\.561\.group\/@red-cup-engineering\/eavt-services-section\/-\/eavt-services-section-0\.5\.0\.tgz"/);
  assert.match(output, /"resolved": "https:\/\/registry\.npmjs\.org\/chalk\/-\/chalk-5\.3\.0\.tgz"/);
  assert.match(output, /"integrity": "sha512-feedface=="/);
});

test("leaves resolved values already pointing at a canonical registry byte-identical", () => {
  const before = lockfileText([
    '    "node_modules/@red-cup-engineering/eavt-services-section": {',
    '      "resolved": "https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",',
    '      "integrity": "sha512-deadbeef=="',
    "    },",
    '    "node_modules/chalk": {',
    '      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz",',
    '      "integrity": "sha512-feedface=="',
    "    }",
  ]);
  const { output, rewrites } = rewritePackageLockText(before);
  assert.deepEqual(rewrites, []);
  assert.equal(output, before);
});

test("parses package and version from a house registry tarball URL", () => {
  assert.deepEqual(
    parseRegistryTarballUrl("https://registry.561.group/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz"),
    { package: "@red-cup-engineering/eavt-services-section", version: "0.5.0" },
  );
  assert.equal(parseRegistryTarballUrl("https://registry.561.group/not-a-tarball-shape"), null);
});

test("walks a directory tree skipping node_modules and caller-supplied exclude substrings", () => {
  const root = mkdtempSync(join(tmpdir(), "repoint-lockfiles-"));
  try {
    mkdirSync(join(root, "package-a"), { recursive: true });
    mkdirSync(join(root, "package-a", "node_modules", "nested"), { recursive: true });
    mkdirSync(join(root, "excluded-service"), { recursive: true });
    mkdirSync(join(root, "package-b"), { recursive: true });
    writeFileSync(join(root, "package-a", "package-lock.json"), "{}");
    writeFileSync(join(root, "package-a", "node_modules", "package-lock.json"), "{}");
    writeFileSync(join(root, "package-a", "node_modules", "nested", "package-lock.json"), "{}");
    writeFileSync(join(root, "excluded-service", "package-lock.json"), "{}");
    writeFileSync(join(root, "package-b", "package-lock.json"), "{}");

    const unfiltered = findPackageLockFiles(root, []);
    assert.deepEqual(unfiltered, [
      join(root, "excluded-service", "package-lock.json"),
      join(root, "package-a", "package-lock.json"),
      join(root, "package-b", "package-lock.json"),
    ].sort());

    const filtered = findPackageLockFiles(root, ["excluded-service"]);
    assert.deepEqual(filtered, [
      join(root, "package-a", "package-lock.json"),
      join(root, "package-b", "package-lock.json"),
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI dry-run reports counts without writing, and --apply writes the rewritten text", () => {
  const root = mkdtempSync(join(tmpdir(), "repoint-cli-"));
  try {
    mkdirSync(join(root, "package-a"), { recursive: true });
    mkdirSync(join(root, "excluded-service"), { recursive: true });
    const houseLock = lockfileText([
      '    "node_modules/@red-cup-engineering/eavt-services-section": {',
      '      "resolved": "http://127.0.0.1:4873/@red-cup-engineering/eavt-services-section/-/eavt-services-section-0.5.0.tgz",',
      '      "integrity": "sha512-deadbeef=="',
      "    },",
      '    "node_modules/lodash": {',
      '      "resolved": "http://127.0.0.1:4873/lodash/-/lodash-4.17.21.tgz",',
      '      "integrity": "sha512-cafef00d=="',
      "    }",
    ]);
    const excludedLock = lockfileText([
      '    "node_modules/lodash": {',
      '      "resolved": "http://127.0.0.1:4873/lodash/-/lodash-4.17.21.tgz",',
      '      "integrity": "sha512-cafef00d=="',
      "    }",
    ]);
    writeFileSync(join(root, "package-a", "package-lock.json"), houseLock);
    writeFileSync(join(root, "excluded-service", "package-lock.json"), excludedLock);

    const dryRun = spawnSync(process.execPath, [SCRIPT_PATH, "--root", root, "--exclude", "excluded-service"], { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunSummary = JSON.parse(dryRun.stdout);
    assert.equal(dryRunSummary.files, 1);
    assert.equal(dryRunSummary.rewrittenUrls, 2);
    assert.equal(dryRunSummary.houseRegistryRewrites, 1);
    assert.equal(dryRunSummary.npmjsRewrites, 1);
    assert.deepEqual(dryRunSummary.skipped, [{ path: join(root, "excluded-service", "package-lock.json"), reason: "excluded" }]);
    assert.equal(dryRunSummary.registryCheck, null);
    assert.equal(readFileSync(join(root, "package-a", "package-lock.json"), "utf8"), houseLock, "dry-run must not write");

    const apply = spawnSync(process.execPath, [SCRIPT_PATH, "--root", root, "--exclude", "excluded-service", "--apply"], { encoding: "utf8" });
    assert.equal(apply.status, 0, apply.stderr);
    const applied = readFileSync(join(root, "package-a", "package-lock.json"), "utf8");
    assert.match(applied, /"resolved": "https:\/\/registry\.561\.group\/@red-cup-engineering\/eavt-services-section\/-\/eavt-services-section-0\.5\.0\.tgz"/);
    assert.match(applied, /"resolved": "https:\/\/registry\.npmjs\.org\/lodash\/-\/lodash-4\.17\.21\.tgz"/);
    assert.equal(readFileSync(join(root, "excluded-service", "package-lock.json"), "utf8"), excludedLock, "excluded lockfile must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an unrecognized CLI argument and a missing --root", () => {
  const missingRoot = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
  assert.notEqual(missingRoot.status, 0);
  const unrecognized = spawnSync(process.execPath, [SCRIPT_PATH, "--root", ".", "--bogus"], { encoding: "utf8" });
  assert.notEqual(unrecognized.status, 0);
});
