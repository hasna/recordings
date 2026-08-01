import { expect, test } from "bun:test";
import { runRepoConformance } from "@hasna/contracts/conformance";
import { loadServiceContractManifest } from "@hasna/contracts/service-contract";

test("hasna.contract.json validates with the tracked contract kit", () => {
  const result = loadServiceContractManifest(import.meta.dir + "/../..");
  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
});

test("the repository satisfies the tracked contract kit's conformance checks", () => {
  const report = runRepoConformance(import.meta.dir + "/../..");
  const failures = report.checks.filter((check) => check.status === "fail");
  expect(failures, failures.map((check) => `${check.id}: ${check.detail}`).join("\n")).toEqual([]);
});
