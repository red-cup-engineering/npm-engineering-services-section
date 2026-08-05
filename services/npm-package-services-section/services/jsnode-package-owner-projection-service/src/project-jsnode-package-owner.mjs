const RULES = Object.freeze([
  ["/services/561-group/services/red-cup-engineering/", "red-cup-engineering"],
  ["/services/561-group/services/lenticule-science/", "lenticule-science"],
  ["/services/561-group/services/board-of-directors/", "harmonious-union"],
  ["/services/561-group/services/rsc-quiescent/services/aagaard/", "aagaard"],
  ["/services/561-group/services/rsc-quiescent/services/agrodao/", "agrodao"],
  ["/services/561-group/services/rsc-quiescent/services/emsweb/", "emsweb"],
  ["/services/561-group/services/rsc-quiescent/services/koios-news/", "koios-news"],
  ["/services/561-group/services/rsc-quiescent/services/turntide-islands/", "turntide-islands"],
  ["/services/561-group/services/rsc-quiescent/", "rsc-quiescent"],
  ["/services/561-group/services/union-officer-academy/", "union-officer-academy"],
  ["/services/561-group/sites/", "561-group"],
  ["/services/561-group/services/", "561-group"],
  ["/services/561-group/lib/", "561-group"],
  ["/services/board-of-directors/", "harmonious-union"],
]);

export function projectJsnodePackageOwner(packagePath) {
  if (typeof packagePath !== "string" || !packagePath) throw new TypeError("packagePath is required");
  const path = "/" + packagePath.replaceAll("\\", "/") + "/";
  const match = RULES.find(([territory]) => path.includes(territory));
  if (!match) throw new Error("no package-owner projection for " + packagePath);
  return Object.freeze({ type: "JsnodePackageOwnerProjection", packagePath, owner: match[1], territory: match[0] });
}
