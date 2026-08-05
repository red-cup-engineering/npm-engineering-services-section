export function normalizeJsnodePackageIdentityReferences({ source, replacements } = {}) {
  if (typeof source !== "string" || !Array.isArray(replacements)) throw new TypeError("source and replacements are required");
  let result = source;
  for (const replacement of replacements) {
    if (!Array.isArray(replacement) || replacement.length !== 2 || replacement.some((value) => typeof value !== "string")) throw new TypeError("each replacement must be a string pair");
    result = result.replaceAll(replacement[0], replacement[1]);
  }
  return result;
}
