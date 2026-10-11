#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { assayPackageInstallResolution } from "../src/npm-package-install-resolution-assay.mjs";

const raw = readFileSync(0, "utf8").trim();
if (raw === "") throw new Error("stdin must be one JSON request with packageSurfaces");
const input = JSON.parse(raw);
const receipt = await assayPackageInstallResolution(input);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.exitCode = receipt.summary.failed === 0 ? 0 : 1;
