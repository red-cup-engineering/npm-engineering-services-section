#!/usr/bin/env node
import process from "node:process";
import { readFile } from "node:fs/promises";
import { argument, requiredArgument, repeatedArgument } from "@red-cup-engineering/javascript-node-services-section/argv";
import { materializeNodeRuntimeProviderCatalog, materializeNodeRuntimeRelease, materializeNodeRuntimeReleaseCatalog, materializeTracedNodeRuntime } from "../src/materialize-release.mjs";

if (argument("--trace-base")) {
  const selectionPath = argument("--runtime-selection");
  const selection = selectionPath ? JSON.parse(await readFile(selectionPath, "utf8")) : null;
  if (selectionPath && (selection?.type !== "NodeRuntimeExecutableSelection" || selection.version !== 1)) throw new TypeError("runtime selection must be NodeRuntimeExecutableSelection v1");
  if (selectionPath && (repeatedArgument("--runtime-entrypoint").length || repeatedArgument("--runtime-asset").length)) throw new TypeError("runtime selection and inline selections are mutually exclusive");
  const receipt = await materializeTracedNodeRuntime({
    base: requiredArgument("--trace-base"),
    output: requiredArgument("--output"),
    entrypoints: selection ? selection.entrypoints : repeatedArgument("--runtime-entrypoint"),
    assets: selection ? selection.assets : repeatedArgument("--runtime-asset"),
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
} else {
const providerAdmission = JSON.parse(await readFile(requiredArgument("--providers"), "utf8"));
if (providerAdmission?.type === "NodeRuntimeProviderAdmission" && providerAdmission.version !== 1) {
  throw new Error("provider admission must be NodeRuntimeProviderAdmission v1");
}
const providers = providerAdmission?.type === "NodeRuntimeProviderAdmission"
  ? { providerSources: providerAdmission.sources ?? {}, providerTarballs: providerAdmission.tarballs ?? {} }
  : providerAdmission?.type === "NodeRuntimeProviderCatalog" && providerAdmission.version === 1
    ? { providerSources: providerAdmission.sources ?? {}, providerTarballs: providerAdmission.tarballs ?? {} }
  : { providerSources: providerAdmission, providerTarballs: {} };
const dependencyExportPolicy = argument("--dependency-export-policy") ?? "strict";
const runtimeEntrypoints = repeatedArgument("--runtime-entrypoint");
const receipt = providerAdmission?.type === "NodeRuntimeProviderCatalog" && providerAdmission.version === 1
  ? await materializeNodeRuntimeProviderCatalog(providerAdmission, requiredArgument("--output"), { dependencyExportPolicy, runtimeEntrypoints })
  : process.argv.includes("--entries")
  ? await materializeNodeRuntimeReleaseCatalog({
      entries: JSON.parse(await readFile(requiredArgument("--entries"), "utf8")),
      ...providers,
      outputRoot: requiredArgument("--output"),
    })
  : await materializeNodeRuntimeRelease({ entryPackageDirectory: requiredArgument("--entry"), ...providers, outputRoot: requiredArgument("--output") });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
