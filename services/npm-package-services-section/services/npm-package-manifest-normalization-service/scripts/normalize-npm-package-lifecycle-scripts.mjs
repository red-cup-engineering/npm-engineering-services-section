#!/usr/bin/env node
// The stdin/stdout CLI entry for normalizeNpmPackageLifecycleScripts, moved out of
// src/normalize-npm-package-lifecycle-scripts.mjs -- see that file's own header comment.
import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { normalizeNpmPackageLifecycleScripts } from "../src/normalize-npm-package-lifecycle-scripts.mjs";
import { collectStreamText } from "../src/stream-text.mjs";

if (import.meta.main) {
  const manifest = JSON.parse(await collectStreamText(process.stdin));
  const normalized = normalizeNpmPackageLifecycleScripts(manifest);
  process.stdout.write(`${canonicalJson(normalized)}\n`);
}
