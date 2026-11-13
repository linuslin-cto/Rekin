import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main as judgeMain } from "../src/cli/judge.js";
import { main as reportMain } from "../src/cli/report.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("demo judge → report path", () => {
  it("prints a score line after judging a finished cell", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-e2e-"));
    try {
      const adapter = new DemoAdapter(root);
      const prop = new DemoProposer(adapter.spec.channels.proposer!);
      runDomain("accounting", ["ledger-1", "ledger-2"], 1, {
        adapter,
        prop,
        runsRoot: adapter.spec.runsRoot,
        libraryRoot: path.join(root, "library"),
        modes: ["agg", "seq"],
      });
      expect(judgeMain(["--output", root, "--k", "1", "--modes", "parallel,sequential"])).toBe(0);
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      try {
        expect(reportMain(["--output", root, "--k", "1"])).toBe(0);
      } finally {
        console.log = orig;
      }
      const text = logs.join("\n");
      expect(text).toContain("demo-oc");
      expect(text).toMatch(/parallel k=1/);
      expect(text).toMatch(/sequential k=1/);
      expect(text).toMatch(/score\s+\d/);
      expect(text).toContain("NOISE FLOOR");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
