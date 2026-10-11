#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyNodeRuntimeRelease, verifyNodeRuntimeReleaseCatalog } from "../src/materialize-release.mjs";

const releaseDirectory = process.argv[2];
if (!releaseDirectory) throw new Error("usage: verify-node-runtime-release /exact/release/directory");
const observation = existsSync(join(releaseDirectory, "runtime-release-catalog.json"))
  ? await verifyNodeRuntimeReleaseCatalog(releaseDirectory)
  : await verifyNodeRuntimeRelease(releaseDirectory);
process.stdout.write(`${JSON.stringify(observation)}\n`);
if (!observation.ok) process.exitCode = 1;
