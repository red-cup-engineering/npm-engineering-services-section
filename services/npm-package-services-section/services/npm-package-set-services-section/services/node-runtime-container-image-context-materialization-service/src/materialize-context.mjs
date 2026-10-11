import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { sha256Digest, sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

export const RECEIPT_FILE = "node-runtime-container-image-context-receipt.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FORBIDDEN_SEGMENTS = new Set([".git", ".npm", ".cache", ".config", ".ssh", "data"]);
const CREDENTIAL_NAMES = [
  /^\.env(?:\..+)?$/u,
  /^\.npmrc$/u,
  /^(?:application[-_.]?default[-_.]?credentials|credentials|service[-_.]?account)(?:\.[^.]+)?\.json$/iu,
  /^(?:id_rsa|id_ed25519|known_hosts)$/u,
];
const SECRET_TEXT = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /["']private_key["']\s*:\s*["'][^-\n]*-----BEGIN/u,
  /(?:^|\n)\s*(?:\/\/[^\n]*?:)?_authToken\s*=\s*[^$\s{][^\n]*/iu,
  /(?:^|\n)\s*_password\s*=\s*[A-Za-z0-9+/]{8,}={0,2}\s*(?:\n|$)/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

function json(value) { return JSON.stringify(value); }
function digestRecord(value) { return sha256Digest(json(value)); }

function exactRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/")) throw new TypeError(`${label} must be one non-empty POSIX relative path`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new TypeError(`${label} contains traversal or an empty segment`);
  return segments.join("/");
}

function overlaps(left, right) { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }

function assertCredentialFree(path, bytes) {
  const segments = path.split("/");
  const forbidden = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment));
  if (forbidden) throw new TypeError(`context carrier ${path} contains forbidden segment ${forbidden}`);
  if (CREDENTIAL_NAMES.some((pattern) => pattern.test(basename(path)))) throw new TypeError(`context carrier ${path} has a credential-shaped filename`);
  const text = bytes.toString("utf8");
  if (SECRET_TEXT.some((pattern) => pattern.test(text))) throw new TypeError(`context carrier ${path} contains secret material`);
}

async function readStableRegularFile(path, contextPath) {
  const pathIdentity = await lstat(path, { bigint: true });
  if (pathIdentity.isSymbolicLink() || !pathIdentity.isFile()) throw new TypeError(`unsupported filesystem carrier ${contextPath}`);
  let handle;
  try { handle = await open(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW); }
  catch (error) { throw new TypeError(`could not open ${contextPath} as one no-follow regular file: ${error.message}`); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathIdentity.dev || before.ino !== pathIdentity.ino) throw new TypeError(`filesystem carrier ${contextPath} changed before admission`);
    const content = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || content.byteLength !== Number(after.size)) throw new TypeError(`filesystem carrier ${contextPath} changed during admission`);
    assertCredentialFree(contextPath, content);
    return Object.freeze({ bytes: content.byteLength, mode: Number(after.mode & 0o777n), sha256: sha256Hex(content), content });
  } finally { await handle.close(); }
}

async function treeFiles(root, { prefix = "", omitReceipt = false } = {}) {
  const absoluteRoot = resolve(root), result = [];
  async function visit(directory, relation = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelation = relation ? `${relation}/${entry.name}` : entry.name;
      if (omitReceipt && childRelation === RECEIPT_FILE) continue;
      const source = join(directory, entry.name), info = await lstat(source);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new TypeError(`unsupported filesystem carrier ${childRelation}`);
      if (info.isDirectory()) await visit(source, childRelation);
      else {
        const path = prefix ? `${prefix}/${childRelation}` : childRelation;
        result.push(Object.freeze({ path, ...await readStableRegularFile(source, path) }));
      }
    }
  }
  await visit(absoluteRoot);
  return result;
}

function artifactDigest(files, mount) {
  const hash = createHash("sha256");
  let bytes = 0;
  const prefix = `${mount}/`;
  const selected = files.filter(({ path }) => path.startsWith(prefix));
  for (const file of selected) {
    const insideMount = file.path.slice(prefix.length);
    bytes += file.bytes;
    hash.update(`app/${insideMount}`); hash.update("\0"); hash.update(file.mode.toString(8)); hash.update("\0");
    hash.update(file.content ?? Buffer.alloc(0)); hash.update("\0");
  }
  return { digest: hash.digest("hex"), fileCount: selected.length, byteCount: bytes };
}

async function measuredFiles(root, options = {}) {
  return treeFiles(root, options);
}

function publicFiles(files) {
  return files.map(({ path, bytes, mode, sha256: digest }) => Object.freeze({ path, bytes, mode, sha256: digest }));
}

function admitCatalogReceipt(value) {
  if (value?.type !== "NodeRuntimeReleaseCatalogReceipt" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length === 0 || !SHA256.test(value.digest ?? "")) throw new TypeError("catalog receipt must be one non-empty NodeRuntimeReleaseCatalogReceipt v1");
  const entries = [...value.entries].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new TypeError("catalog entry identities must be unique");
  for (const entry of entries) {
    if (!SAFE_ID.test(entry?.id ?? "") || !SHA256.test(entry?.artifactDigest ?? "") || entry.releaseRelativePath !== `../../releases/${entry.artifactDigest}`) throw new TypeError(`catalog entry ${entry?.id ?? "<unknown>"} is malformed or not digest-bound`);
  }
  const body = { type: value.type, version: value.version, entries: value.entries };
  if (sha256Hex(json(body)) !== value.digest) throw new TypeError("catalog receipt digest is invalid");
  return Object.freeze({ ...body, digest: value.digest });
}

function normalizePolicy(value, catalog) {
  if (value?.type !== "NodeRuntimeContainerImageLayoutPolicy" || value.version !== 1 || !Array.isArray(value.entries)) throw new TypeError("layout policy must be one NodeRuntimeContainerImageLayoutPolicy v1");
  const entries = value.entries.map((entry) => {
    if (!SAFE_ID.test(entry?.id ?? "")) throw new TypeError("layout entry identities must be unique filesystem-safe values");
    return Object.freeze({ id: entry.id, mount: exactRelativePath(entry.mount, `layout mount for ${entry.id}`) });
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new TypeError("layout entry identities must be unique filesystem-safe values");
  const catalogIds = [...catalog.entries].map(({ id }) => id).sort();
  if (json(entries.map(({ id }) => id)) !== json(catalogIds)) throw new TypeError("layout policy must map every catalog entry exactly once");
  for (let left = 0; left < entries.length; left += 1) for (let right = left + 1; right < entries.length; right += 1) if (overlaps(entries[left].mount, entries[right].mount)) throw new TypeError(`layout mounts overlap: ${entries[left].mount} and ${entries[right].mount}`);
  if (entries.some(({ mount }) => overlaps(mount, RECEIPT_FILE))) throw new TypeError("layout mount overlaps the context receipt");
  return Object.freeze({ type: value.type, version: value.version, entries: Object.freeze(entries) });
}

function normalizeObservation(value, catalog) {
  if (value?.type !== "NodeRuntimeReleaseCatalogVerificationObservation" || value.ok !== true || value.expectedDigest !== catalog.digest || value.observedDigest !== catalog.digest || !Array.isArray(value.entries)) throw new TypeError("verification observation does not verify the supplied runtime catalog");
  const entries = [...value.entries].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (json(entries.map(({ id, ok }) => ({ id, ok }))) !== json([...catalog.entries].sort((a, b) => a.id.localeCompare(b.id)).map(({ id }) => ({ id, ok: true })))) throw new TypeError("verification observation does not cover every catalog entry exactly once");
  return structuredClone(value);
}

async function normalizeStaticCarriers(carriers) {
  if (!Array.isArray(carriers)) throw new TypeError("staticCarriers must be an array");
  const expanded = [];
  for (const carrier of carriers) {
    const path = exactRelativePath(carrier?.path, "static carrier path");
    const forms = ["sourcePath", "utf8", "base64"].filter((name) => carrier?.[name] !== undefined);
    if (forms.length !== 1) throw new TypeError(`static carrier ${path} requires exactly one of sourcePath, utf8, or base64`);
    if (forms[0] === "sourcePath") {
      const source = resolve(String(carrier.sourcePath)), info = await lstat(source);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new TypeError(`static carrier ${path} names an unsupported filesystem carrier`);
      if (info.isDirectory()) {
        const files = await measuredFiles(source, { prefix: path });
        if (files.length === 0) throw new TypeError(`static carrier ${path} names an empty directory`);
        expanded.push(...files);
      }
      else {
        expanded.push(Object.freeze({ path, ...await readStableRegularFile(source, path) }));
      }
    } else {
      if (typeof carrier[forms[0]] !== "string") throw new TypeError(`static carrier ${path} ${forms[0]} must be a string`);
      const content = forms[0] === "utf8" ? Buffer.from(carrier.utf8, "utf8") : Buffer.from(carrier.base64, "base64");
      if (forms[0] === "base64" && content.toString("base64") !== carrier.base64) throw new TypeError(`static carrier ${path} is not canonical base64`);
      assertCredentialFree(path, content);
      const mode = Number.isInteger(carrier.mode) ? carrier.mode : 0o644;
      if (mode < 0 || mode > 0o777) throw new TypeError(`static carrier ${path} has an invalid regular-file mode`);
      expanded.push(Object.freeze({ path, bytes: content.byteLength, mode, sha256: sha256Hex(content), content }));
    }
  }
  expanded.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(expanded.map(({ path }) => path)).size !== expanded.length) throw new TypeError("static carrier destinations overlap exactly");
  for (let left = 0; left < expanded.length; left += 1) for (let right = left + 1; right < expanded.length; right += 1) if (overlaps(expanded[left].path, expanded[right].path)) throw new TypeError(`static carrier destinations overlap: ${expanded[left].path} and ${expanded[right].path}`);
  return expanded;
}

async function writeBytesExact(bytes, target, mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new TypeError(`invalid regular-file mode for ${target}`);
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, "wx", mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); }
  finally { await handle.close(); }
  const observedMode = (await lstat(target)).mode & 0o777;
  if (observedMode !== mode) throw new TypeError(`filesystem cannot preserve declared mode ${mode.toString(8)} for ${target}`);
}

function assertNoDestinationOverlap(policy, staticFiles) {
  for (const { mount } of policy.entries) for (const { path } of staticFiles) if (overlaps(mount, path)) throw new TypeError(`static carrier ${path} overlaps runtime mount ${mount}`);
  if (staticFiles.some(({ path }) => overlaps(path, RECEIPT_FILE))) throw new TypeError("static carrier overlaps the context receipt");
}

function requireAuthority(authority) {
  if (typeof authority?.verifyNodeRuntimeReleaseCatalog !== "function" || typeof authority?.verifyNodeRuntimeRelease !== "function") throw new TypeError("runtimeReleaseAuthority must supply the release owner's catalog and release verification functions");
  return authority;
}

async function readCatalog(catalogDirectory, supplied) {
  const persisted = JSON.parse(await readFile(join(catalogDirectory, "runtime-release-catalog.json"), "utf8"));
  const admitted = admitCatalogReceipt(persisted);
  if (supplied !== undefined && json(admitCatalogReceipt(supplied)) !== json(admitted)) throw new TypeError("supplied catalog receipt differs from its catalog directory");
  return admitted;
}

export async function materializeNodeRuntimeContainerImageContext(input, { runtimeReleaseAuthority } = {}) {
  const authority = requireAuthority(runtimeReleaseAuthority);
  const catalogDirectory = await realpath(input?.catalogDirectory ?? "");
  const output = resolve(String(input?.outputDirectory ?? ""));
  if (output === "/") throw new TypeError("outputDirectory must be one non-root path");
  const outputFromCatalog = relative(catalogDirectory, output);
  if (outputFromCatalog === "" || (!outputFromCatalog.startsWith(`..${sep}`) && outputFromCatalog !== "..")) throw new TypeError("outputDirectory must be outside the runtime catalog territory");
  try { await lstat(output); throw new TypeError("outputDirectory must not already exist"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const catalog = await readCatalog(catalogDirectory, input?.runtimeReleaseCatalogReceipt);
  const suppliedObservation = normalizeObservation(input?.verificationObservation, catalog);
  const freshObservation = await authority.verifyNodeRuntimeReleaseCatalog(catalogDirectory);
  if (json(freshObservation) !== json(suppliedObservation)) throw new TypeError("fresh runtime catalog verification differs from the supplied exact observation");
  const policy = normalizePolicy(input?.layoutPolicy, catalog);
  const staticFiles = await normalizeStaticCarriers(input?.staticCarriers ?? []);
  assertNoDestinationOverlap(policy, staticFiles);
  await mkdir(dirname(output), { recursive: true });
  try { await mkdir(output, { recursive: false }); }
  catch (error) { if (error?.code === "EEXIST") throw new TypeError("outputDirectory must not already exist"); throw error; }
  try {
    const catalogIndex = new Map(catalog.entries.map((entry) => [entry.id, entry])), mountedEntries = [];
    for (const declaration of policy.entries) {
      const entry = catalogIndex.get(declaration.id), releaseDirectory = resolve(catalogDirectory, entry.releaseRelativePath);
      const releaseObservation = await authority.verifyNodeRuntimeRelease(releaseDirectory);
      if (!releaseObservation.ok || releaseObservation.expectedDigest !== entry.artifactDigest || releaseObservation.observedDigest !== entry.artifactDigest) throw new TypeError(`runtime release ${entry.id} no longer agrees with its catalog artifact digest`);
      const sourceFiles = await measuredFiles(join(releaseDirectory, "app"), { prefix: declaration.mount });
      for (const file of sourceFiles) await writeBytesExact(file.content, join(output, ...file.path.split("/")), file.mode);
      const copied = await measuredFiles(join(output, ...declaration.mount.split("/")), { prefix: declaration.mount });
      const observed = artifactDigest(copied, declaration.mount);
      if (observed.digest !== entry.artifactDigest) throw new TypeError(`copied runtime release ${entry.id} differs from catalog artifact ${entry.artifactDigest}`);
      mountedEntries.push(Object.freeze({ id: entry.id, entryPackage: entry.entryPackage ?? null, entryVersion: entry.entryVersion ?? null, artifactDigest: entry.artifactDigest, mount: declaration.mount, fileCount: observed.fileCount, byteCount: observed.byteCount }));
    }
    for (const file of staticFiles) await writeBytesExact(file.content, join(output, ...file.path.split("/")), file.mode);
    const finalMeasured = await measuredFiles(output, { omitReceipt: true });
    const body = Object.freeze({
      type: "NodeRuntimeContainerImageContextReceipt",
      version: 1,
      runtimeReleaseCatalogDigest: catalog.digest,
      verificationObservationDigest: digestRecord(suppliedObservation),
      policy,
      policyDigest: digestRecord(policy),
      identityScope: "regular-file-path-bytes-mode",
      entries: mountedEntries,
      staticCarriers: publicFiles(staticFiles),
      files: publicFiles(finalMeasured),
    });
    const receipt = Object.freeze({ ...body, digest: digestRecord(body) });
    await writeFile(join(output, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    const selfObservation = await verifyNodeRuntimeContainerImageContext({ contextDirectory: output, receipt });
    if (!selfObservation.ok) throw new Error(`materialized context failed its owner verification: ${selfObservation.defects.join(", ")}`);
    return receipt;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

function admitReceipt(value) {
  if (value?.type !== "NodeRuntimeContainerImageContextReceipt" || value.version !== 1 || value.identityScope !== "regular-file-path-bytes-mode" || !Array.isArray(value.entries) || !Array.isArray(value.staticCarriers) || !Array.isArray(value.files) || !SHA256.test(String(value.runtimeReleaseCatalogDigest ?? "")) || !/^sha256:[a-f0-9]{64}$/u.test(value.policyDigest ?? "") || !/^sha256:[a-f0-9]{64}$/u.test(value.verificationObservationDigest ?? "") || !/^sha256:[a-f0-9]{64}$/u.test(value.digest ?? "")) throw new TypeError("value is not a NodeRuntimeContainerImageContextReceipt v1");
  if (value.policy?.type !== "NodeRuntimeContainerImageLayoutPolicy" || value.policy.version !== 1 || !Array.isArray(value.policy.entries)) throw new TypeError("context receipt layout policy is malformed");
  const entryIds = new Set(), mounts = [];
  for (const entry of value.entries) {
    const mount = exactRelativePath(entry?.mount, `receipt mount for ${entry?.id ?? "<unknown>"}`);
    if (!SAFE_ID.test(entry?.id ?? "") || entryIds.has(entry.id) || !SHA256.test(entry.artifactDigest ?? "") || !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1 || !Number.isSafeInteger(entry.byteCount) || entry.byteCount < 0) throw new TypeError("context receipt runtime entry is malformed");
    entryIds.add(entry.id); mounts.push(mount);
  }
  for (let left = 0; left < mounts.length; left += 1) for (let right = left + 1; right < mounts.length; right += 1) if (overlaps(mounts[left], mounts[right])) throw new TypeError("context receipt runtime mounts overlap");
  const policyMap = new Map(value.policy.entries.map((entry) => [entry?.id, entry?.mount]));
  if (policyMap.size !== value.entries.length || value.entries.some((entry) => policyMap.get(entry.id) !== entry.mount)) throw new TypeError("context receipt entries disagree with its layout policy");
  const admitIdentities = (identities, label) => {
    const paths = new Set();
    for (const identity of identities) {
      const path = exactRelativePath(identity?.path, `${label} path`);
      if (path === RECEIPT_FILE || paths.has(path) || !Number.isSafeInteger(identity.bytes) || identity.bytes < 0 || !Number.isInteger(identity.mode) || identity.mode < 0 || identity.mode > 0o777 || !SHA256.test(identity.sha256 ?? "")) throw new TypeError(`${label} identities are malformed or repeated`);
      paths.add(path);
    }
  };
  admitIdentities(value.files, "context file");
  admitIdentities(value.staticCarriers, "static carrier");
  const body = { type: value.type, version: value.version, runtimeReleaseCatalogDigest: value.runtimeReleaseCatalogDigest, verificationObservationDigest: value.verificationObservationDigest, policy: value.policy, policyDigest: value.policyDigest, identityScope: value.identityScope, entries: value.entries, staticCarriers: value.staticCarriers, files: value.files };
  if (digestRecord(value.policy) !== value.policyDigest || digestRecord(body) !== value.digest) throw new TypeError("context receipt canonical digest is invalid");
  return value;
}

export async function verifyNodeRuntimeContainerImageContext({ contextDirectory, receipt } = {}) {
  const root = await realpath(contextDirectory ?? "");
  const supplied = admitReceipt(receipt ?? JSON.parse(await readFile(join(root, RECEIPT_FILE), "utf8")));
  const defects = [];
  let measured;
  try { measured = await measuredFiles(root, { omitReceipt: true }); }
  catch (error) {
    defects.push(`context-inspection-refused:${error.message}`);
    return Object.freeze({ type: "NodeRuntimeContainerImageContextVerificationObservation", version: 1, ok: false, expectedDigest: supplied.digest, observedDigest: null, runtimeReleaseCatalogDigest: supplied.runtimeReleaseCatalogDigest, defects: Object.freeze(defects) });
  }
  if (json(publicFiles(measured)) !== json(supplied.files)) defects.push("final-file-identities-differ");
  for (const entry of supplied.entries) {
    try {
      const mount = exactRelativePath(entry.mount, `receipt mount for ${entry.id}`), observed = artifactDigest(measured, mount);
      if (observed.digest !== entry.artifactDigest || observed.fileCount !== entry.fileCount || observed.byteCount !== entry.byteCount) defects.push(`runtime-artifact-differs:${entry.id}`);
    } catch { defects.push(`runtime-mount-invalid:${entry?.id ?? "unknown"}`); }
  }
  const identities = new Map(supplied.files.map((file) => [file.path, file]));
  for (const carrier of supplied.staticCarriers) {
    const observed = identities.get(carrier.path);
    if (!observed || observed.bytes !== carrier.bytes || observed.mode !== carrier.mode || observed.sha256 !== carrier.sha256) defects.push(`static-carrier-differs:${carrier.path}`);
  }
  return Object.freeze({ type: "NodeRuntimeContainerImageContextVerificationObservation", version: 1, ok: defects.length === 0, expectedDigest: supplied.digest, observedDigest: defects.length === 0 ? supplied.digest : null, runtimeReleaseCatalogDigest: supplied.runtimeReleaseCatalogDigest, defects: Object.freeze(defects.sort()) });
}
