#!/usr/bin/env node
// The stdin/stdout CLI entry for normalizePnpmPackageManagerDeclaration, moved out of
// src/normalize-pnpm-package-manager-declaration.mjs -- see that file's own header comment.
import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { normalizePnpmPackageManagerDeclaration } from "../src/normalize-pnpm-package-manager-declaration.mjs";
import { collectStreamText } from "../src/stream-text.mjs";

if (import.meta.main) {
  const manifest = JSON.parse(await collectStreamText(process.stdin));
  const normalized = normalizePnpmPackageManagerDeclaration(manifest);
  process.stdout.write(`${canonicalJson(normalized)}\n`);
}
