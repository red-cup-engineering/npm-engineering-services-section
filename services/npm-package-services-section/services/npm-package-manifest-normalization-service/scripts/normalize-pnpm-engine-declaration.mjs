#!/usr/bin/env node
// The stdin/stdout CLI entry for normalizePnpmEngineDeclaration, moved out of
// src/normalize-pnpm-engine-declaration.mjs -- see that file's own header comment.
import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { normalizePnpmEngineDeclaration } from "../src/normalize-pnpm-engine-declaration.mjs";
import { collectStreamText } from "../src/stream-text.mjs";

if (import.meta.main) {
  const manifest = JSON.parse(await collectStreamText(process.stdin));
  const normalized = normalizePnpmEngineDeclaration(manifest);
  process.stdout.write(`${canonicalJson(normalized)}\n`);
}
