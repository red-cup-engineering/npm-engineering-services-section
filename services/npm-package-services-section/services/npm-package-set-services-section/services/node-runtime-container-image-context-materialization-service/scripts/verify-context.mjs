#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { verifyNodeRuntimeContainerImageContext } from "../src/materialize-context.mjs";

function option(name, required = true) {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1];
  if (required && !value) throw new TypeError(`${name} is required`);
  return value;
}
const receiptPath = option("--receipt", false);
const observation = await verifyNodeRuntimeContainerImageContext({ contextDirectory: option("--context"), ...(receiptPath ? { receipt: JSON.parse(await readFile(receiptPath, "utf8")) } : {}) });
process.stdout.write(`${JSON.stringify(observation)}\n`);
if (!observation.ok) process.exitCode = 1;
