#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { materializeNodeRuntimeContainerImageContext } from "../src/materialize-context.mjs";
import * as runtimeReleaseAuthority from "@red-cup-engineering/node-runtime-release-materialization-service";

function option(name, required = true) {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1];
  if (required && !value) throw new TypeError(`${name} is required`);
  return value;
}
async function document(path) { return JSON.parse(await readFile(path, "utf8")); }

const receiptPath = option("--catalog-receipt", false);
const staticPath = option("--static-carriers", false);
const receipt = await materializeNodeRuntimeContainerImageContext({
  catalogDirectory: option("--catalog-directory"),
  ...(receiptPath ? { runtimeReleaseCatalogReceipt: await document(receiptPath) } : {}),
  verificationObservation: await document(option("--verification-observation")),
  layoutPolicy: await document(option("--layout-policy")),
  staticCarriers: staticPath ? await document(staticPath) : [],
  outputDirectory: option("--output"),
}, { runtimeReleaseAuthority });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
