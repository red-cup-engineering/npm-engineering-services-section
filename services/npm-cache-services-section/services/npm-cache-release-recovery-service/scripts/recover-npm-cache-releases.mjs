#!/usr/bin/env node
// CLI entrypoint for recoverNpmCacheReleases; logic lives in
// ../src/recover-npm-cache-releases.mjs. Usage:
//   recover-npm-cache-releases --cache /path/to/npm-cache \
//     --lock /work/a/package-lock.json [--lock /work/b/package-lock.json ...] \
//     [--output /srv/recovered-tarballs]

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runMain } from "@red-cup-engineering/javascript-file-engineering-services-section/javascript-file-main-guard";

import { recoverNpmCacheReleases } from "../src/recover-npm-cache-releases.mjs";

export { recoverNpmCacheReleases };

function usage() {
  return "usage: recover-npm-cache-releases --cache <npm-cache-dir> --lock <package-lock.json> [--lock <package-lock.json> ...] [--output <dir>] [--source <path> ...] [--archive <path> ...] [--export-cache <new-dir>]\n";
}

export function parseRecoveryOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      cache: { type: "string" },
      lock: { type: "string", multiple: true, default: [] },
      output: { type: "string" },
      source: { type: "string", multiple: true },
      archive: { type: "string", multiple: true },
      "export-cache": { type: "string" },
      help: { type: "boolean", default: false }
    }
  });
  if (values.help) return { help: true };
  if (!values.cache) throw new Error("--cache is required and must name an npm cache directory");
  if (values.lock.length === 0) throw new Error("at least one --lock is required");
  return { cachePath: values.cache, lockPaths: values.lock, outputPath: values.output,
    ...(values.source ? { sourcePaths: values.source } : {}),
    ...(values.archive ? { archivePaths: values.archive } : {}),
    ...(values["export-cache"] ? { portableCachePath: values["export-cache"] } : {}) };
}

async function main(argv) {
  const options = parseRecoveryOptions(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await recoverNpmCacheReleases(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.complete) process.exitCode = 1;
}

runMain(({ argv }) => main(argv), {
  moduleUrl: import.meta.url,
  isEntry: (url, entry) => resolve(fileURLToPath(url)) === resolve(entry ?? ""),
  formatError: (error) => `${error.message}\n`,
  exitCode: 1,
});
