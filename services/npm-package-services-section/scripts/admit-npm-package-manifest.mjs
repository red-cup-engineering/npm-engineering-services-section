#!/usr/bin/env node
import { admitNpmPackageManifest } from "@red-cup-engineering/npm-package-manifest-admission-service";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "admit-npm-package-manifest", description: "Admits one npm package manifest candidate without changing its fields.", operation: admitNpmPackageManifest }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
