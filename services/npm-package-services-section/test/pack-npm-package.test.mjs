import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packNpmPackage } from "../scripts/pack-npm-package.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "npm-package-packing-"));
  const carrier = join(root, "carrier"), destination = join(root, "destination");
  await mkdir(carrier);
  await mkdir(destination);
  await writeFile(join(carrier, "package.json"), '{"name":"@customer/carrier","version":"1.0.0"}\n');
  return { root, carrier, destination };
}

test("runs npm pack with scripts disabled and an isolated cache, then returns its one observed JSON artifact", async () => {
  const { root, carrier, destination } = await fixture();
  try {
    let invocation;
    const result = await packNpmPackage({ type: "NpmPackagePackingRequest", version: 1,
      carrierDirectory: carrier,
      destinationDirectory: destination,
    }, { async execute(command, arguments_, options) {
        invocation = { command, arguments_, options };
        await writeFile(join(destination, "carrier-1.0.0.tgz"), "tarball");
        return { stdout: '[{"filename":"carrier-1.0.0.tgz"}]', stderr: "" };
      },
    });
    assert.deepEqual(result, { type: "NpmPackagePackingReceipt", version: 1, carrierDirectory: carrier, destinationDirectory: destination, artifactPath: join(destination, "carrier-1.0.0.tgz"), filename: "carrier-1.0.0.tgz" });
    assert.equal(invocation.command, "npm");
    assert.deepEqual(invocation.arguments_, ["pack", "--ignore-scripts", "--json", "--pack-destination", destination]);
    assert.equal(invocation.options.cwd, carrier);
    assert.match(invocation.options.env.npm_config_cache, /npm-package-packing-cache-/u);
    await assert.rejects(() => access(invocation.options.env.npm_config_cache), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses absent, plural, and path-escaping JSON reports deterministically", async () => {
  const { root, carrier, destination } = await fixture();
  try {
    for (const [stdout, code] of [
      ["", "INVALID_NPM_REPORT"],
      ['[{"filename":"one.tgz"},{"filename":"two.tgz"}]', "INVALID_NPM_REPORT"],
      ['[{"filename":"../outside.tgz"}]', "INVALID_NPM_REPORT"],
    ]) {
      await assert.rejects(
        () => packNpmPackage({ type: "NpmPackagePackingRequest", version: 1, carrierDirectory: carrier, destinationDirectory: destination }, { async execute() { return { stdout, stderr: "" }; } }),
        (error) => error.code === code,
      );
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a missing or symbolic-link artifact named by npm", async () => {
  const { root, carrier, destination } = await fixture();
  try {
    const execute = async () => ({ stdout: '[{"filename":"carrier.tgz"}]', stderr: "" });
    await assert.rejects(() => packNpmPackage({ type: "NpmPackagePackingRequest", version: 1, carrierDirectory: carrier, destinationDirectory: destination }, { execute }), { code: "MISSING_ARTIFACT" });
    await writeFile(join(root, "outside.tgz"), "outside");
    await symlink(join(root, "outside.tgz"), join(destination, "carrier.tgz"));
    await assert.rejects(() => packNpmPackage({ type: "NpmPackagePackingRequest", version: 1, carrierDirectory: carrier, destinationDirectory: destination }, { execute }), { code: "INVALID_ARTIFACT" });
    assert.equal((await lstat(join(destination, "carrier.tgz"))).isSymbolicLink(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("characterizes npm's real JSON report and does not run package scripts", async () => {
  const { root, carrier, destination } = await fixture();
  try {
    await writeFile(join(carrier, "package.json"), JSON.stringify({ name: "@customer/carrier", version: "1.0.0", scripts: { prepack: "node -e \"process.exit(97)\"" } }));
    const result = await packNpmPackage({ type: "NpmPackagePackingRequest", version: 1, carrierDirectory: carrier, destinationDirectory: destination });
    assert.equal(result.filename.endsWith(".tgz"), true);
    assert.equal((await lstat(result.artifactPath)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
