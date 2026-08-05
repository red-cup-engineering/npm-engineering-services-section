import { glob, readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

const EXTENSIONS = new Set([".cjs", ".cts", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const EXCLUDED = Object.freeze(["**/node_modules/**", "**/.git/**", "**/content/assets/legacy/**", "**/src/content/assets/legacy/**", "**/data/runtime-images/**", "**/dev/content/triage/prior-app/**", "**/.archive/**", "**/.cache/**", "**/.venv/**", "**/venv/**", "**/build/**", "**/dist/**"]);

function slash(path) { return path.split(sep).join("/"); }

export async function observeJsnodePackageBody({ root } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  const absoluteRoot = resolve(root), manifestCandidates = new Set();
  for await (const path of glob("lib/emsenn/services/**/package.json", { cwd: absoluteRoot, exclude: EXCLUDED })) manifestCandidates.add(path);
  const packages = [];
  for (const path of [...manifestCandidates].sort()) {
    const manifest = JSON.parse(await readFile(resolve(absoluteRoot, path), "utf8"));
    if (typeof manifest.name === "string" && manifest.name) packages.push({ path, manifest });
  }
  const directories = packages.map(({ path }) => slash(dirname(path))).sort((a, b) => b.length - a.length);
  const extensions = [...EXTENSIONS].map((value) => value.slice(1)).sort().join(",");
  const sourceFiles = [];
  for await (const path of glob("lib/emsenn/services/**/*.{" + extensions + "}", {
    cwd: absoluteRoot,
    exclude: ["**/node_modules/**", "**/.git/**", "**/data/**", "**/content/**", "**/dev/**", "**/dist/**", "**/test/**", "**/tests/**"],
  })) {
    const carried = directories.some((directory) => path === directory || path.startsWith(directory + "/"));
    if (carried && EXTENSIONS.has(extname(path)) && !path.endsWith("package-lock.json") && !path.endsWith("package.json")) sourceFiles.push(path);
  }
  return Object.freeze({ type: "JsnodePackageBodyObservation", root: absoluteRoot, packages: Object.freeze(packages), sourceFiles: Object.freeze([...new Set(sourceFiles)].sort()) });
}
