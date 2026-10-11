import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/u;

function octal(bytes, label) {
  const value = bytes.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]*$/u.test(value)) throw new Error(`npm tarball has invalid ${label}`);
  return value === "" ? 0 : Number.parseInt(value, 8);
}

function field(bytes) {
  return bytes.toString("utf8").replace(/\0.*$/u, "");
}

function archiveMemberPath(name) {
  if (name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
    throw new Error(`npm tarball member path is unsafe: ${JSON.stringify(name)}`);
  }
  const source = name.replace(/\/+$/u, "");
  if (source === "" || source.split("/").includes("..")) {
    throw new Error(`npm tarball member path traverses its package root: ${JSON.stringify(name)}`);
  }
  const normalized = posix.normalize(source).replace(/^\.\//u, "");
  if (normalized === "." || normalized === "" || normalized.startsWith("../")) {
    throw new Error(`npm tarball member has no top-level directory: ${JSON.stringify(name)}`);
  }
  return normalized;
}

function admitArchiveRoot(entries) {
  const roots = new Set(entries.map(({ path }) => path.split("/", 1)[0]));
  if (roots.size !== 1) throw new Error("npm tarball must have one top-level directory");
  const [root] = roots;
  return entries.map((entry) => ({
    ...entry,
    path: entry.path === root ? "" : entry.path.slice(root.length + 1),
  }));
}

function coalesceArchiveEntries(entries) {
  const admitted = new Map();
  for (const entry of entries) {
    const prior = admitted.get(entry.path);
    if (prior === undefined) {
      admitted.set(entry.path, entry);
      continue;
    }
    if (prior.directory !== entry.directory || prior.mode !== entry.mode || !prior.bytes.equals(entry.bytes)) {
      throw new Error(`npm tarball contains conflicting duplicate member ${entry.path}`);
    }
  }
  return [...admitted.values()];
}

function parsePax(bytes) {
  const values = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error("npm tarball has malformed PAX metadata");
    const length = Number.parseInt(bytes.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) throw new Error("npm tarball has malformed PAX record length");
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function tarEntries(gzipBytes) {
  const archive = gunzipSync(gzipBytes);
  const entries = [];
  let offset = 0;
  let pax = {};
  let longPath = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = octal(header.subarray(148, 156), "header checksum");
    const observedChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (expectedChecksum !== observedChecksum) throw new Error("npm tarball has invalid header checksum");
    const size = octal(header.subarray(124, 136), "member size");
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error("npm tarball member exceeds archive bounds");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header.subarray(345, 500));
    const headerPath = `${prefix ? `${prefix}/` : ""}${field(header.subarray(0, 100))}`;
    const body = archive.subarray(bodyStart, bodyEnd);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") { pax = { ...pax, ...parsePax(body) }; continue; }
    if (type === "L") { longPath = field(body); continue; }
    const name = pax.path ?? longPath ?? headerPath;
    pax = {};
    longPath = null;
    if (type !== "0" && type !== "\0" && type !== "5") {
      throw new Error(`npm tarball member ${JSON.stringify(name)} has unsupported type ${JSON.stringify(type)}`);
    }
    entries.push({ path: archiveMemberPath(name), directory: type === "5", mode: octal(header.subarray(100, 108), "member mode") & 0o777, bytes: body });
  }
  return coalesceArchiveEntries(admitArchiveRoot(entries));
}

export async function admitNpmTarballProvider(claimedName, claim, extractionRoot) {
  if (claim === null || typeof claim !== "object" || Array.isArray(claim)) throw new TypeError(`tarball provider ${claimedName} must be an object`);
  if (claim.name !== claimedName) throw new Error(`tarball provider claim ${claimedName} names ${claim.name ?? "<absent>"}`);
  if (!EXACT_VERSION.test(claim.version ?? "")) throw new Error(`tarball provider ${claimedName} has no exact claimed version`);
  const integrityMatch = SHA512_INTEGRITY.exec(claim.integrity ?? "");
  if (!integrityMatch) throw new Error(`tarball provider ${claimedName} must carry one canonical sha512 integrity`);
  if (typeof claim.tarballPath !== "string" || !claim.tarballPath) throw new Error(`tarball provider ${claimedName} has no tarballPath`);
  const tarballPath = resolve(claim.tarballPath);
  const bytes = await readFile(tarballPath);
  const observedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (observedIntegrity !== claim.integrity) throw new Error(`tarball provider ${claimedName}@${claim.version} integrity mismatch`);
  const destination = resolve(extractionRoot, ...claimedName.split("/"));
  for (const entry of tarEntries(bytes)) {
    if (entry.path === "") {
      if (!entry.directory) throw new Error("npm tarball top-level root must be a directory");
      continue;
    }
    const target = resolve(destination, ...entry.path.split("/"));
    const relativeTarget = target.slice(destination.length + (target === destination ? 0 : 1));
    if (target !== destination && (target.slice(0, destination.length + 1) !== `${destination}${sep}` || relativeTarget.startsWith(`..${sep}`))) {
      throw new Error(`npm tarball member escapes extraction root: ${entry.path}`);
    }
    if (entry.directory) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.bytes, { flag: "wx" });
      await chmod(target, entry.mode || 0o644);
    }
  }
  const manifest = JSON.parse(await readFile(resolve(destination, "package.json"), "utf8"));
  if (manifest.name !== claimedName) throw new Error(`tarball provider claim ${claimedName} contains ${manifest.name ?? "<absent>"}`);
  if (manifest.version !== claim.version) throw new Error(`tarball provider ${claimedName} claimed ${claim.version} but contains ${manifest.version ?? "<absent>"}`);
  return { kind: "tarball", directory: destination, manifest, integrity: claim.integrity, tarballPath };
}
