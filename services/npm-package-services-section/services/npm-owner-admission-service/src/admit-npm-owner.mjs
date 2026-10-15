/**
 * Admits one already-canonical lowercase npm scope owner.
 * @param {string} candidate - The owner without an at-sign.
 * @returns {string} The unchanged owner.
 * @throws {TypeError} When the candidate is not canonical.
 */
export function admitNpmOwner(candidate) {
  if (typeof candidate !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(candidate)) {
    throw new TypeError("candidate must be a canonical lowercase npm owner without an at-sign");
  }
  return candidate;
}
