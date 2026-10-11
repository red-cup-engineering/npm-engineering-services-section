#!/usr/bin/env node
// The stdin/stdout CLI entry for applyNpmPackageManifestIdentity, moved out of
// src/apply-npm-package-manifest-identity.mjs -- see that file's own header comment.
import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { applyNpmPackageManifestIdentity } from "../src/apply-npm-package-manifest-identity.mjs";
import { collectStreamText } from "../src/stream-text.mjs";

if (import.meta.main) {
  const request = JSON.parse(await collectStreamText(process.stdin));
  const manifest = applyNpmPackageManifestIdentity(request);
  process.stdout.write(`${canonicalJson(manifest)}\n`);
}
