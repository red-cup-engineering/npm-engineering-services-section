import { admitNpmOwner } from "@red-cup-engineering/npm-owner-admission-service";
import { admitNpmPackageNameLeaf } from "@red-cup-engineering/npm-package-name-leaf-admission-service";

/**
 * Forms one scoped npm package name from separately admitted owner and leaf inputs.
 * @param {object} request - An NpmScopedPackageNameFormationRequest@1.
 * @returns {string} The scoped package name.
 */
export function formNpmScopedPackageName(request) {
  if (
    request === null
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "leaf,owner,type,version"
    || request.type !== "NpmScopedPackageNameFormationRequest"
    || request.version !== 1
  ) {
    throw new TypeError("request must be an exact NpmScopedPackageNameFormationRequest@1");
  }
  return `@${admitNpmOwner(request.owner)}/${admitNpmPackageNameLeaf(request.leaf)}`;
}
