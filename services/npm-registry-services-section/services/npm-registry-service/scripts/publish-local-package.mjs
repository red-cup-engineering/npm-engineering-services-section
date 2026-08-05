#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildPackageRegistry, recoverPackageRegistryReceipt } from "../src/package-registry.mjs";
import { deriveRegistryGraph, renderRegistryGraphDot } from "../src/registry-graph.mjs";

const execute = promisify(execFile);

function option(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (!required) return undefined;
  throw new Error(`${name} is required`);
}

const packageDirectories = process.argv.flatMap((value, index) =>
  value === "--package" && process.argv[index + 1] ? [resolve(process.argv[index + 1])] : []);
if (packageDirectories.length === 0) throw new Error("at least one --package is required");

const registryDirectory = resolve(option("--registry"));
const registryUrl = new URL(option("--registry-url"));
const serviceUnit = option("--service-unit");
if (registryUrl.hostname !== "127.0.0.1" && registryUrl.hostname !== "localhost") {
  throw new Error("local publication requires a loopback registry URL");
}

const receiptPath = join(registryDirectory, "registry-receipt.json");
let currentReceipt;
try {
  currentReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  currentReceipt = await recoverPackageRegistryReceipt({ registryDirectory, registryUrl: registryUrl.href });
  await writeFile(receiptPath, `${JSON.stringify(currentReceipt, null, 2)}\n`);
}
if (currentReceipt.registry !== registryUrl.href) {
  throw new Error(`active registry declares ${currentReceipt.registry}, not ${registryUrl.href}`);
}

const manifests = await Promise.all(packageDirectories.map(async (directory) =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"))));
const parent = dirname(registryDirectory);
const candidate = await mkdtemp(join(parent, `.${basename(registryDirectory)}.candidate-`));
const displaced = join(parent, `.${basename(registryDirectory)}.displaced-${process.pid}`);
let stopped = false;
let displacedActive = false;

async function service(action) {
  await execute("systemctl", ["--user", action, serviceUnit]);
}

async function readActivatedMetadata(name) {
  const url = new URL(encodeURIComponent(name), registryUrl);
  let lastError;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw Object.assign(new Error(`activated registry did not become readable for ${name}`), { cause: lastError });
}

try {
  const receipt = await buildPackageRegistry({
    packageDirectories,
    outputDirectory: candidate,
    baseRegistryDirectory: registryDirectory,
    registryUrl: registryUrl.href,
  });
  const graph = await deriveRegistryGraph({ registryRoot: candidate });
  const graphDirectory = join(candidate, "graph");
  await mkdir(graphDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(graphDirectory, "npm-registry-graph.json"), `${JSON.stringify(graph, null, 2)}\n`),
    writeFile(join(graphDirectory, "dependency-tier.dot"), renderRegistryGraphDot(graph, { tier: "dependency" })),
  ]);

  await service("stop");
  stopped = true;
  await rename(registryDirectory, displaced);
  displacedActive = true;
  await rename(candidate, registryDirectory);
  await service("start");
  stopped = false;

  for (const manifest of manifests) {
    const metadata = await readActivatedMetadata(manifest.name);
    if (metadata.versions?.[manifest.version]?.name !== manifest.name) {
      throw new Error(`activated registry does not expose ${manifest.name}@${manifest.version}`);
    }
  }

  await rm(displaced, { recursive: true });
  displacedActive = false;
  process.stdout.write(`${JSON.stringify({
    type: "LocalNpmPackagePublicationReceipt",
    registry: registryUrl.href,
    packages: manifests.map(({ name, version }) => `${name}@${version}`),
    packageCount: receipt.packageCount,
    releases: receipt.packages.length,
  }, null, 2)}\n`);
} catch (error) {
  if (displacedActive) {
    await service("stop").catch(() => {});
    await rm(registryDirectory, { recursive: true, force: true }).catch(() => {});
    await rename(displaced, registryDirectory).catch(() => {});
    displacedActive = false;
    await service("start").catch(() => {});
    stopped = false;
  } else if (stopped) {
    await service("start").catch(() => {});
  }
  await rm(candidate, { recursive: true, force: true }).catch(() => {});
  throw error;
}
