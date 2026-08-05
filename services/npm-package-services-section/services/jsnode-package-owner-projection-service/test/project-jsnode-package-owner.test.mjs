import assert from "node:assert/strict";
import test from "node:test";
import { projectJsnodePackageOwner } from "../src/project-jsnode-package-owner.mjs";

test("projects the most specific declared package-owner territory", () => {
  assert.equal(projectJsnodePackageOwner("lib/emsenn/services/561-group/services/rsc-quiescent/services/aagaard/services/x").owner, "aagaard");
  assert.equal(projectJsnodePackageOwner("lib/emsenn/services/561-group/services/red-cup-engineering/services/x").owner, "red-cup-engineering");
});

test("refuses a path outside the declared projection", () => {
  assert.throws(() => projectJsnodePackageOwner("tmp/example"), /no package-owner projection/u);
});
