#!/usr/bin/env node
import { createPackageRegistryServer } from "../src/package-registry.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const host = option("--host", "127.0.0.1");
const port = Number.parseInt(option("--port", "4873"), 10);
const server = createPackageRegistryServer({ registryDirectory: option("--registry", process.cwd()) });
server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ type: "SemioticVoxelPackageRegistryListening", host, port })}\n`));
