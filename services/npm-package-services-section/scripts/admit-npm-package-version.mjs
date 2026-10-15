#!/usr/bin/env node
import { admitNpmPackageVersion } from "@red-cup-engineering/npm-package-version-admission-service";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-version", description: "Admits one explicit exact SemVer npm package version.", operation: admitNpmPackageVersion }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
