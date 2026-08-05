#!/usr/bin/env node
import { normalizeJsnodePackageBody } from "../src/normalize-jsnode-package-body.mjs";

const apply = process.argv.includes("--apply");
const positional = process.argv.slice(2).filter((value) => value !== "--apply");
process.stdout.write(JSON.stringify(await normalizeJsnodePackageBody({ root: positional[0] ?? process.cwd(), apply }), null, 2) + "\n");
