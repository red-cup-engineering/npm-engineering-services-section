#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { canonical, parse } from "@red-cup-engineering/json-services-section";
import { normalizeJsnodePackageManifest } from "../src/normalize-jsnode-package-manifest.mjs";

if (import.meta.main) {
  const [manifestPath, identityName] = process.argv.slice(2);
  if (!manifestPath || !identityName || process.argv.length !== 4) {
    throw new TypeError("usage: normalize-jsnode-package-manifest MANIFEST_PATH IDENTITY_NAME");
  }
  const manifest = parse(await readFile(manifestPath, "utf8"));
  const normalized = normalizeJsnodePackageManifest({ manifest, identity: { name: identityName } });
  process.stdout.write(`${canonical(normalized)}\n`);
}
