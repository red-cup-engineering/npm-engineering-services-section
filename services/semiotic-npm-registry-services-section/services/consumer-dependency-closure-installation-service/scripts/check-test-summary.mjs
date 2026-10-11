import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Validate the declared Node runner's TAP envelope and summary, not the
// authenticity of untrusted output. Source review remains separate. Process
// exit status is enforced by the workflow's pipefail shell.
export function requirePassingTestSummary(output) {
  output = output.replaceAll("\r\n", "\n");
  if ([...output.matchAll(/^TAP version 13$/gmu)].length !== 1) {
    throw new Error("missing or duplicate TAP header");
  }
  if (/^\s*(?:not ok\b|Bail out!)/gimu.test(output)
      || /^[ \t]*(?:not )?ok [^\n]*[ \t]#[ \t]*(?:SKIP|TODO)\b/gimu.test(output)) {
    throw new Error("unsuccessful, skipped or incomplete TAP result");
  }
  const plans = [...output.matchAll(/^1\.\.(\d+)$/gmu)];
  const results = [...output.matchAll(/^ok (\d+)(?:\s|$)/gmu)];
  if (plans.length !== 1 || Number(plans[0][1]) === 0
      || Number(plans[0][1]) !== results.length
      || results.some((result, index) => Number(result[1]) !== index + 1)) {
    throw new Error("missing or inconsistent TAP plan/results");
  }
  const counts = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (Object.hasOwn(counts, key)) throw new Error(`duplicate test summary: ${key}`);
    counts[key] = Number(value);
    if (!Number.isSafeInteger(counts[key])) throw new Error(`invalid test summary: ${key}`);
  }
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    if (!Object.hasOwn(counts, key)) throw new Error(`missing test summary: ${key}`);
  }
  if (counts.tests < results.length || counts.pass !== counts.tests
      || counts.fail !== 0 || counts.cancelled !== 0
      || counts.skipped !== 0 || counts.todo !== 0) {
    throw new Error(`incomplete or unsuccessful tests: ${JSON.stringify(counts)}`);
  }
  return Object.freeze(counts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = requirePassingTestSummary(readFileSync(0, "utf8"));
    process.stdout.write(`Verified ${summary.tests} completed tests\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
