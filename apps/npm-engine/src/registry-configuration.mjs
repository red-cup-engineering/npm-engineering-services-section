import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

function registryAddress(value) {
  const address = new URL(value);
  if (!["https:", "http:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new TypeError("npm registry selection requires an HTTP(S) address without credentials or query");
  }
  if (!address.pathname.endsWith("/")) address.pathname += "/";
  return address.href;
}

export async function readNpmRegistryConfiguration({ root, registry, signal }) {
  const args = ["config", "list", "--json"];
  if (registry !== undefined) args.push("--registry=" + registryAddress(registry));
  const { stdout } = await execute("npm", args, {
    cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15000, signal,
  });
  const configuration = JSON.parse(stdout);
  const scopes = Object.fromEntries(Object.entries(configuration)
    .filter(([key]) => /^@[^/:]+:registry$/u.test(key))
    .map(([key, value]) => [key.slice(0, -":registry".length), registryAddress(value)]));
  return { registry: registryAddress(configuration.registry), scopes };
}

export function registryForPackage({ registry, scopes }, name) {
  const scope = name.startsWith("@") ? name.split("/")[0] : undefined;
  return scopes[scope] ?? registry;
}
