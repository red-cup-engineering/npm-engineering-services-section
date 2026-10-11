#!/usr/bin/env node
// install-consumer-dependency-closure — one typed act on stdin, one typed
// record on stdout. Never prose.
//
//   echo '{"consumer":"lib/emsenn/.../some-service"}' \
//     | install-consumer-dependency-closure.mjs
//
// Input record: { consumer, registryUrl?, publicRegistryUrl?, npmCommand? }
// Output: ConsumerDependencyClosureReceipt (exit 0)
//     or  ConsumerDependencyClosureRefusal (exit 3)
//     or  a usage refusal (exit 2).

import { readFileSync } from "node:fs";
import { installConsumerDependencyClosure, ClosureRefusal } from "../src/install-consumer-dependency-closure.mjs";

const OK = 0;
const USAGE = 2;
const REFUSED = 3;

function emit(record, code) {
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  process.exit(code);
}

let raw;
try {
  raw = readFileSync(0, "utf8").trim();
} catch {
  emit({ type: "ConsumerDependencyClosureRefusal", version: 1, law: "usage", diagnostic: "no stdin — this installs a closure from data, never from prose" }, USAGE);
}
if (!raw) emit({ type: "ConsumerDependencyClosureRefusal", version: 1, law: "usage", diagnostic: "no data on stdin" }, USAGE);

let input;
try {
  input = JSON.parse(raw);
} catch (error) {
  emit({ type: "ConsumerDependencyClosureRefusal", version: 1, law: "usage", diagnostic: `stdin is not JSON: ${error.message}` }, USAGE);
}

try {
  const receipt = await installConsumerDependencyClosure({
    consumerPath: input.consumer,
    ...(input.registryUrl === undefined ? {} : { registryUrl: input.registryUrl }),
    ...(input.publicRegistryUrl === undefined ? {} : { publicRegistryUrl: input.publicRegistryUrl }),
    ...(input.npmCommand === undefined ? {} : { npmCommand: input.npmCommand }),
  });
  emit(receipt, OK);
} catch (error) {
  if (error instanceof ClosureRefusal) emit(error.refusal, REFUSED);
  emit({ type: "ConsumerDependencyClosureRefusal", version: 1, law: "unexpected", diagnostic: error.message }, REFUSED);
}
