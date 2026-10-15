/**
 * Admits one already-canonical lowercase npm package-name leaf.
 * @param {string} candidate - The candidate leaf.
 * @returns {string} The unchanged leaf.
 * @throws {TypeError} When the candidate is invalid.
 */
export function admitNpmPackageNameLeaf(candidate) {
  if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(candidate)) {
    throw new TypeError("candidate must be a canonical lowercase npm package-name leaf");
  }
  return candidate;
}
