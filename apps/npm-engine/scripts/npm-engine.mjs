#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import {
  applyNpmPackageNormalization,
  planNpmPackageNormalization,
} from "../src/package-normalization.mjs";

const usage = [
  "npm-engine normalize ROOT [MANIFEST...] [--owner OWNER] [--registry URL] [--output FILE]",
  "npm-engine apply-normalization ROOT PLAN [--output FILE]",
].join("\n");

async function outputPath(root, requestedPath) {
  const selectedRoot = await realpath(root);
  const requested = resolve(requestedPath);
  const output = join(await realpath(dirname(requested)), basename(requested));
  const displacement = relative(selectedRoot, output);
  if (!displacement || (!isAbsolute(displacement) && displacement !== ".." && !displacement.startsWith(`..${sep}`))) {
    throw new TypeError("normalization output belongs outside the selected source directory");
  }
  const existing = await lstat(output).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new TypeError("normalization output must name a file");
  }
  return output;
}

async function run([command, ...args]) {
  if (command === "--help" || command === "-h") {
    process.stdout.write(usage + "\n");
    return;
  }
  if (command !== "normalize" && command !== "apply-normalization") throw new TypeError(usage);
  const planning = command === "normalize";
  const options = { output: { type: "string" }, help: { type: "boolean", short: "h" } };
  if (planning) {
    options.owner = { type: "string" };
    options.registry = { type: "string" };
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (values.help) {
    process.stdout.write(usage + "\n");
    return;
  }
  const [root, ...paths] = positionals;
  if (!root) throw new TypeError("name the selected source root");
  if (!planning && paths.length !== 1) throw new TypeError("apply-normalization requires one source root and one plan file");
  const output = values.output === undefined ? undefined : await outputPath(root, values.output);
  const report = planning
    ? await planNpmPackageNormalization({
      root, manifestPaths: paths.length ? paths : undefined, owner: values.owner, registry: values.registry,
    })
    : await applyNpmPackageNormalization({ root, plan: JSON.parse(await readFile(paths[0], "utf8")) });
  let outputError;
  if (output) {
    try {
      await writeFileText(output, JSON.stringify(report, null, 2) + "\n");
    } catch (error) {
      outputError = error.message;
    }
  }
  const summary = output ? {
    type: report.type,
    version: report.version,
    ready: report.ready,
    applied: report.applied,
    packages: report.packages,
    manifestFilesChanged: report.manifestFilesChanged,
    consumerFilesChanged: report.consumerFilesChanged,
    requirements: report.requirements.length,
    unmet: report.failures.length,
    output,
    ...(outputError === undefined ? {} : { outputError }),
  } : report;
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exitCode = report.ready && outputError === undefined ? 0 : 1;
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  process.stdout.write(JSON.stringify({ type: "NpmPackageNormalizationInputRefusal", reason: error.message }) + "\n");
  process.exitCode = 2;
}
