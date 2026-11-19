import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { makeNiUri } from "@red-cup-engineering/semiotic-content-address-system";
import { writeFileBytes } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { parseJavaScript } from "@red-cup-engineering/javascript-parser-service";
import { readJavaScriptModuleRequestSites } from "@red-cup-engineering/javascript-parser-service/module-reference-sites";
import { normalizeJsnodeModuleEdges } from "@red-cup-engineering/jsnode-cross-package-module-edge-normalization-service";

export function requireSourcePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")
    || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("source paths must be canonical and relative to the selected root");
  }
  return path.split("/");
}

export async function readSource(root, path, { missing = false } = {}) {
  const parts = requireSourcePath(path);
  let target = root;
  try {
    for (const [index, part] of parts.entries()) {
      target = join(target, part);
      const entry = await lstat(target);
      if (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
        throw new TypeError("normalization requires an owned regular source file");
      }
    }
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new TypeError("normalization requires an owned regular source file");
      const bytes = await file.readFile();
      return { target, stat, bytes, ni: makeNiUri(bytes) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing && error.code === "ENOENT") return { target, ni: null };
    throw error;
  }
}

async function moduleSites(path, text) {
  const extension = extname(path);
  if ([".ts", ".cts", ".mts", ".jsx", ".tsx"].includes(extension)) {
    const { default: ts } = await import("typescript");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2024, true);
    if (source.parseDiagnostics.length) {
      throw new SyntaxError(ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, "\n"));
    }
    const sites = [];
    const add = request => {
      if (request && ts.isStringLiteralLike(request)) {
        sites.push({ specifier: request.text, start: request.getStart(source), end: request.end });
      }
    };
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
    return sites;
  }
  if (extension === ".cjs") {
    return readJavaScriptModuleRequestSites(parseJavaScript(text, { sourceType: "script" }));
  }
  try {
    return readJavaScriptModuleRequestSites(parseJavaScript(text));
  } catch (error) {
    if (extension !== ".js" || !(error instanceof SyntaxError)) throw error;
    return readJavaScriptModuleRequestSites(parseJavaScript(text, { sourceType: "script" }));
  }
}

const relativeSpecifier = value => value.startsWith("./") || value.startsWith("../");
const moduleExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

export async function planModuleRequests({ root, path, text, carriers, renamedPackages }) {
  if (!moduleExtension.test(path) || (carriers.length < 2 && renamedPackages.size === 0)) return { text, dependencies: [] };

  const sites = await moduleSites(path, text);
  const changes = [], dependencies = [];
  for (const { specifier, start, end } of sites) {
    if (specifier === null) continue;
    let next = specifier;
    if (relativeSpecifier(specifier)) {
      // The existing resolver accepts a module body. Give it the admitted
      // literal alone so it cannot treat comments or strings as imports.
      const request = `import ${JSON.stringify(specifier)};`;
      const projected = await normalizeJsnodeModuleEdges({ root, path, source: request, carriers });
      if (projected.source !== request) {
        const [site] = readJavaScriptModuleRequestSites(parseJavaScript(projected.source));
        next = site.specifier;
        dependencies.push(projected);
      }
    } else {
      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      const replacement = renamedPackages.get(name);
      if (replacement !== undefined) next = replacement + specifier.slice(name.length);
    }
    if (next !== specifier) changes.push({ start, end, text: JSON.stringify(next) });
  }
  let result = text;
  for (const edit of changes.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { text: result, dependencies };
}

function sourceChanged(path) {
  return { kind: "source-changed", path, reason: "source differs from the received plan" };
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

export async function receiveInputs(root, inputs) {
  const observed = new Map(), failures = [];
  for (const [path, ni] of inputs) {
    const input = await readSource(root, path, { missing: true });
    if (input.ni !== ni) failures.push(sourceChanged(path));
    observed.set(path, input);
  }
  return { observed, failures };
}

export async function replacePlannedSources(root, inputs, changes, original) {
  const prepared = [], installed = [], kept = new Set();
  let activePath;
  try {
    for (const change of changes) {
      activePath = change.path;
      const { target, stat, bytes } = original.get(change.path);
      const staging = await mkdtemp(join(dirname(target), ".npm-engine-"));
      const next = join(staging, "replacement"), before = join(staging, "original");
      const row = { change, target, staging, next, before };
      prepared.push(row);
      const mode = stat.mode & 0o777;
      await writeFileBytes(before, bytes, { flag: "wx", mode });
      await writeFileBytes(next, Buffer.from(change.content), { flag: "wx", mode });
      row.replacement = await lstat(next);
    }
    const { failures } = await receiveInputs(root, inputs);
    if (failures.length) return failures;
    for (const row of prepared) {
      activePath = row.change.path;
      const current = await readSource(root, row.change.path, { missing: true });
      if (current.ni !== row.change.before || !sameFile(current.stat, original.get(activePath).stat)) {
        const error = new Error("source differs from the received plan");
        error.kind = "source-changed";
        throw error;
      }
      await rename(row.next, row.target);
      installed.push(row);
    }
    return [];
  } catch (error) {
    const failures = [{ kind: error.kind ?? "write-failed", path: activePath, reason: error.message }];
    for (const row of installed.reverse()) {
      try {
        const current = await readSource(root, row.change.path, { missing: true });
        if (current.ni !== row.change.after || !sameFile(current.stat, row.replacement)) {
          throw new Error("source changed after this operation installed it");
        }
        await rename(row.before, row.target);
      } catch (restoration) {
        kept.add(row.staging);
        failures.push({
          kind: "restore-failed", path: row.change.path, reason: restoration.message,
          original: row.before,
        });
      }
    }
    return failures;
  } finally {
    for (const row of prepared) {
      if (!kept.has(row.staging)) await rm(row.staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}
