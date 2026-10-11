import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requirePassingTestSummary } from "../scripts/check-test-summary.mjs";

const passing = "TAP version 13\nok 1 - one\nok 2 - two\nok 3 - three\nok 4 - four\nok 5 - five\n1..5\n# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";

test("CI accepts a complete successful Node TAP summary", () => {
  assert.equal(requirePassingTestSummary(passing).tests, 5);
  assert.equal(requirePassingTestSummary(passing.replaceAll("\n", "\r\n")).pass, 5);
});

for (const [name, output] of [
  ["no summary", ""],
  ["zero tests", passing.replace("tests 5", "tests 0").replace("pass 5", "pass 0")],
  ["failed tests", passing.replace("fail 0", "fail 1")],
  ["cancelled tests", passing.replace("cancelled 0", "cancelled 1")],
  ["skipped tests", passing.replace("skipped 0", "skipped 1")],
  ["todo tests", passing.replace("todo 0", "todo 1")],
  ["inconsistent counts", passing.replace("pass 5", "pass 4")],
  ["missing counts", passing.replace("# fail 0\n", "")],
  ["duplicate counts", `${passing}# tests 5\n`],
  ["unsafe integer", passing.replace("tests 5", "tests 9007199254740993")],
  ["missing TAP header", passing.replace("TAP version 13\n", "")],
  ["missing TAP plan", passing.replace("1..5\n", "")],
  ["zero TAP plan", passing.replace("1..5", "1..0")],
  ["contradictory TAP plan", passing.replace("1..5", "1..6")],
  ["contradictory failed result", passing.replace("ok 1", "not ok 1")],
  ["duplicate result index", passing.replace("ok 2", "ok 1")],
  ["skip directive", passing.replace("one\n", "one # SKIP\n")],
  ["bailout", `${passing}Bail out!\n`],
]) {
  test(`CI refuses ${name}`, () => assert.throws(() => requirePassingTestSummary(output)));
}

test("CI summary command reports failure to the calling process", () => {
  const command = new URL("../scripts/check-test-summary.mjs", import.meta.url);
  const good = spawnSync(process.execPath, [fileURLToPath(command)], { input: passing, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  const bad = spawnSync(process.execPath, [fileURLToPath(command)], { input: "", encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /missing or duplicate TAP header/u);
});
