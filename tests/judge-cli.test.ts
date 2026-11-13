import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main as judgeMain } from "../src/cli/judge.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("judge CLI (demo)", () => {
  it("writes judged.json for a finished demo sweep", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-judge-cli-"));
    try {
      const adapter = new DemoAdapter(root);
      const prop = new DemoProposer(adapter.spec.channels.proposer!);
      runDomain("accounting", ["ledger-1"], 1, {
        adapter,
        prop,
        runsRoot: adapter.spec.runsRoot,
        libraryRoot: path.join(root, "library"),
        modes: ["agg"],
      });
      const code = judgeMain(["--output", root, "--k", "1", "--mode", "parallel"]);
      // Base harness omits credits, so selection may pick a failing answer; exit 2 is ok if ungraded/fail.
      expect([0, 2]).toContain(code);
      const judged = path.join(adapter.spec.runsRoot, "demo-oc-agg1", "judged.json");
      expect(fs.existsSync(judged)).toBe(true);
      const rows = JSON.parse(fs.readFileSync(judged, "utf8")) as { graded: boolean }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => typeof r.graded === "boolean")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
