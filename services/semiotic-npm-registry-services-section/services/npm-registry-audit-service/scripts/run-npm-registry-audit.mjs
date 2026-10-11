#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runNpmRegistryAudit } from "../src/run-npm-registry-audit.mjs";

const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    config: { type: "string" },
    out: { type: "string" },
    "allow-defects": { type: "boolean", default: false },
  },
});

if (!values.registry) throw new Error("--registry <url> is required, e.g. http://127.0.0.1:4873");
if (!values.config) throw new Error("--config <path> is required: the Verdaccio config.yaml this registry runs, the sole source of its internal scopes");
if (!values.out) throw new Error("--out <dir> is required: where npm-registry-graph.json, dependency-tier.dot, and the summary are written");

const configYamlText = await readFile(values.config, "utf8");
const result = await runNpmRegistryAudit({ registryUrl: values.registry, configYamlText });

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, "npm-registry-graph.json"), result.artifacts.json);
await writeFile(join(values.out, "dependency-tier.dot"), result.artifacts.dot);

process.stdout.write(`${JSON.stringify(result.artifacts.summary, null, 2)}\n`);

if (!result.ok && !values["allow-defects"]) {
  for (const group of result.artifacts.summary.defectGroups) {
    process.stderr.write(`registry graph defect group: ${group.kind} -> ${group.target} (${group.relation}); ${group.count} consumer(s)\n`);
  }
  process.exitCode = 1;
}
