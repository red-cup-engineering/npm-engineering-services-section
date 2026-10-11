#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** House npm scopes that resolve through the canonical registry.561.group, without the leading `@`. */
const HOUSE_SCOPES = Object.freeze(["561-group", "causeway-services", "coesite-operations", "emsenn", "lenticule-science", "red-cup-engineering"]);

const RESOLVED_FIELD_PATTERN = /("resolved"\s*:\s*")([^"]*)(")/g;
const HOUSE_REGISTRY_RESOLVED_PATTERN = /"resolved"\s*:\s*"(https:\/\/registry\.561\.group\/[^"]*)"/g;

/**
 * Collects every distinct house-scoped `resolved` URL already pointed at the canonical house
 * registry in raw package-lock.json text, whether it arrived there just now or was already
 * correct. Filters to house-scoped paths only, as a safety net: a non-house package resolving
 * through registry.561.group is itself rewritten to registry.npmjs.org by
 * {@link rewritePackageLockText}, so none should remain here after a rewrite pass.
 *
 * @param {string} text Raw (post-rewrite) package-lock.json file text.
 * @param {readonly string[]} [houseScopes] House npm scopes (without `@`) admitted to the check.
 * @returns {Set<string>} Distinct `https://registry.561.group/@<houseScope>/...` URLs found.
 */
export function collectHouseRegistryResolvedUrls(text, houseScopes = HOUSE_SCOPES) {
  const urls = new Set();
  for (const match of text.matchAll(HOUSE_REGISTRY_RESOLVED_PATTERN)) {
    const url = match[1];
    let pathname;
    try {
      ({ pathname } = new URL(url));
    } catch {
      continue;
    }
    if (houseScopes.some((scope) => pathname.startsWith(`/@${scope}/`))) urls.add(url);
  }
  return urls;
}

/**
 * Classifies one lockfile `resolved` URL against three questions: is its host one of the fully
 * dead hosts (the laptop cache, the retired GCP IP, a Cloud Run mirror); is its path house-scoped;
 * and, independently, is it a non-house package misrouted through registry.561.group (which only
 * serves the six house scopes anonymously — everything else belongs on registry.npmjs.org).
 * `url` carries the rewrite target whenever either condition holds; it is `null` when the URL is
 * already correct or unrecognized.
 *
 * @param {string} resolvedUrl A `resolved` field value read from a package-lock.json.
 * @param {readonly string[]} [houseScopes] House npm scopes (without `@`) that resolve through registry.561.group.
 * @returns {{ deadHost: boolean, houseScoped: boolean, misrouted: boolean, url: string|null }}
 */
export function classifyResolvedUrl(resolvedUrl, houseScopes = HOUSE_SCOPES) {
  const unrecognized = { deadHost: false, houseScoped: false, misrouted: false, url: null };
  if (typeof resolvedUrl !== "string" || resolvedUrl.length === 0) return unrecognized;
  let parsed;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    return unrecognized;
  }
  const { hostname } = parsed;
  const deadHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "34.61.173.187" || hostname.endsWith(".run.app");
  const houseScoped = houseScopes.some((scope) => parsed.pathname.startsWith(`/@${scope}/`));
  const misrouted = !deadHost && hostname === "registry.561.group" && !houseScoped;
  if (!deadHost && !misrouted) return { deadHost: false, houseScoped, misrouted: false, url: null };
  const origin = houseScoped ? "https://registry.561.group" : "https://registry.npmjs.org";
  return { deadHost, houseScoped, misrouted, url: `${origin}${parsed.pathname}${parsed.search}${parsed.hash}` };
}

/**
 * Rewrites every `resolved` URL in raw package-lock.json text that {@link classifyResolvedUrl}
 * finds wrong — a dead host (the laptop cache, the retired GCP IP, a Cloud Run mirror) or a
 * non-house package misrouted through registry.561.group — to its scope-appropriate canonical
 * registry origin, as a targeted text substitution that leaves every other byte (formatting, key
 * order, `integrity`, already-correct `resolved` values) untouched.
 *
 * @param {string} text Raw package-lock.json file text.
 * @param {readonly string[]} [houseScopes] House npm scopes consulted by {@link classifyResolvedUrl}.
 * @returns {{ output: string, rewrites: Array<{ from: string, to: string }> }} `output` equals `text` when `rewrites` is empty.
 */
export function rewritePackageLockText(text, houseScopes = HOUSE_SCOPES) {
  const rewrites = [];
  const output = text.replace(RESOLVED_FIELD_PATTERN, (match, prefix, url, suffix) => {
    const classification = classifyResolvedUrl(url, houseScopes);
    if (classification.url === null) return match;
    rewrites.push({ from: url, to: classification.url });
    return `${prefix}${classification.url}${suffix}`;
  });
  return { output, rewrites };
}

/**
 * Recursively collects absolute paths to every `package-lock.json` beneath a root directory.
 * Never descends into a directory named `node_modules`; never returns a path containing any of
 * the supplied exclude substrings.
 *
 * @param {string} root Directory to walk (need not be absolute; the walk resolves it first).
 * @param {readonly string[]} [excludeSubstrings] Path substrings that remove a matching lockfile from the result.
 * @returns {string[]} Absolute paths, sorted.
 */
export function findPackageLockFiles(root, excludeSubstrings = []) {
  const found = [];
  const stack = [resolve(root)];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name === "package-lock.json") {
        if (excludeSubstrings.some((substring) => entryPath.includes(substring))) continue;
        found.push(entryPath);
      }
    }
  }
  return found.sort();
}

/**
 * Parses the `{ package, version }` a house registry tarball URL names, from its
 * `/@scope/name/-/name-version.tgz` path shape.
 *
 * @param {string} url A tarball URL.
 * @returns {{ package: string, version: string }|null} `null` when the path does not match the shape.
 */
export function parseRegistryTarballUrl(url) {
  let pathname;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter((part) => part.length > 0);
  const dashIndex = parts.indexOf("-");
  if (dashIndex < 1 || parts.length !== dashIndex + 2) return null;
  const packageName = parts.slice(0, dashIndex).join("/");
  const baseName = parts[dashIndex - 1];
  const filename = parts[dashIndex + 1];
  if (!filename.endsWith(".tgz") || !filename.startsWith(`${baseName}-`)) return null;
  return { package: packageName, version: filename.slice(baseName.length + 1, -4) };
}

/**
 * Probes one URL for reachability: HEAD first, falling back to a ranged GET when HEAD is not
 * supported (405/501) or errors.
 *
 * @param {string} url URL to probe.
 * @param {{ timeoutMs: number, fetchImplementation: typeof fetch }} options Probe policy.
 * @returns {Promise<number|null>} The HTTP status, or `null` when every attempt failed to complete.
 */
async function probeRegistryUrl(url, { timeoutMs, fetchImplementation }) {
  for (const init of [{ method: "HEAD" }, { method: "GET", headers: { Range: "bytes=0-0" } }]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(url, { ...init, signal: controller.signal });
      if (init.method === "HEAD" && (response.status === 405 || response.status === 501)) continue;
      return response.status;
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Checks a set of registry tarball URLs for reachability, bounded by a concurrency cap.
 *
 * @param {readonly string[]} urls Distinct tarball URLs to check.
 * @param {{ timeoutMs?: number, concurrency?: number, fetchImplementation?: typeof fetch }} [options] Probe policy.
 * @returns {Promise<{ checked: number, failures: Array<{ package: string|null, version: string|null, url: string, status: number|null }> }>}
 */
export async function checkRegistryUrls(urls, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const concurrency = options.concurrency ?? 16;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const status = await probeRegistryUrl(url, { timeoutMs, fetchImplementation });
      if (status === null || status < 200 || status >= 300) {
        const parsed = parseRegistryTarballUrl(url);
        failures.push({ package: parsed?.package ?? null, version: parsed?.version ?? null, url, status });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  failures.sort((a, b) => a.url.localeCompare(b.url));
  return { checked: urls.length, failures };
}

/**
 * Parses this script's CLI arguments.
 *
 * @param {readonly string[]} argv `process.argv.slice(2)`.
 * @returns {{ root: string, exclude: string[], apply: boolean, checkRegistry: boolean }}
 * @throws {Error} When `--root` is missing or an argument is unrecognized.
 */
export function parseRepointCliArguments(argv) {
  const options = { root: null, exclude: [], apply: false, checkRegistry: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--exclude") options.exclude.push(argv[++index]);
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--check-registry") options.checkRegistry = true;
    else throw new Error(`unrecognized argument: ${argument}`);
  }
  if (typeof options.root !== "string" || options.root.length === 0) throw new Error("--root <dir> is required");
  return options;
}

if (import.meta.main) {
  const options = parseRepointCliArguments(process.argv.slice(2));
  const root = resolve(options.root);
  const allLockfiles = findPackageLockFiles(root, []);
  const skipped = [];
  const toProcess = [];
  for (const file of allLockfiles) {
    if (options.exclude.some((substring) => file.includes(substring))) skipped.push({ path: file, reason: "excluded" });
    else toProcess.push(file);
  }

  let rewrittenUrls = 0;
  let houseRegistryRewrites = 0;
  let npmjsRewrites = 0;
  const filesWithRewrites = [];
  const houseUrls = new Set();

  for (const file of toProcess) {
    const text = readFileSync(file, "utf8");
    const { output, rewrites } = rewritePackageLockText(text);
    if (options.checkRegistry) for (const url of collectHouseRegistryResolvedUrls(output)) houseUrls.add(url);
    if (rewrites.length === 0) continue;
    filesWithRewrites.push(file);
    for (const { to } of rewrites) {
      rewrittenUrls++;
      if (to.startsWith("https://registry.561.group/")) houseRegistryRewrites++;
      else if (to.startsWith("https://registry.npmjs.org/")) npmjsRewrites++;
    }
    if (options.apply) writeFileSync(file, output);
  }

  const registryCheck = options.checkRegistry ? await checkRegistryUrls([...houseUrls].sort()) : null;

  process.stdout.write(`${JSON.stringify({
    files: filesWithRewrites.length,
    rewrittenUrls,
    skipped,
    houseRegistryRewrites,
    npmjsRewrites,
    registryCheck,
  }, null, 2)}\n`);
}
