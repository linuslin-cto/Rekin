import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectSelections,
  hasGrade,
  judgeSelections,
  loadRows,
  mergeRows,
  Scored,
  write,
} from "../src/core/judge.js";
import type { BenchmarkAdapter } from "../src/core/spec.js";

describe("judge", () => {
  it("hasGrade requires positive denominator", () => {
    expect(hasGrade(0, 3)).toBe(true);
    expect(hasGrade(null, 3)).toBe(false);
    expect(hasGrade(1, 0)).toBe(false);
  });

  it("skips scoring when selection is not ok", () => {
    const score = vi.fn(() => ({ n_passed: 1, n_criteria: 1, all_pass: true }));
    const adapter = { score } as unknown as BenchmarkAdapter;
    const rows = judgeSelections(adapter, [
      {
        task_id: "t1",
        mode: "agg",
        k: 1,
        ok: false,
        chosen_label: "agg1",
        chosen_run_dir: "/tmp/x",
      },
    ]);
    expect(score).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.graded).toBe(false);
    expect(rows[0]!.nPassed).toBeNull();
    expect(rows[0]!.error).toMatch(/selection did not complete/);
  });

  it("records frac and graded on success", () => {
    const s = new Scored({
      taskId: "t",
      mode: "agg",
      k: 1,
      label: "agg1",
      runId: "r",
      nPassed: 2,
      nCriteria: 4,
    });
    expect(s.graded).toBe(true);
    expect(s.frac).toBe(0.5);
  });

  it("merge keeps a graded row when a re-judge fails", () => {
    const graded = new Scored({
      taskId: "t1",
      mode: "agg",
      k: 1,
      label: "agg1",
      runId: "r1",
      selectedAt: "t0",
      nPassed: 1,
      nCriteria: 1,
    });
    const failed = new Scored({
      taskId: "t1",
      mode: "agg",
      k: 1,
      label: "agg1",
      runId: "r1",
      selectedAt: "t0",
      error: "judge returned nothing",
    });
    const merged = mergeRows([graded], [failed]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.graded).toBe(true);
    expect(merged[0]!.nPassed).toBe(1);
  });

  it("merge replaces when selected_at changes under the same run id", () => {
    const old = new Scored({
      taskId: "t1",
      mode: "agg",
      k: 1,
      label: "agg1",
      runId: "r1",
      selectedAt: "t0",
      nPassed: 1,
      nCriteria: 1,
    });
    const newer = new Scored({
      taskId: "t1",
      mode: "agg",
      k: 1,
      label: "agg1",
      runId: "r1",
      selectedAt: "t1",
      nPassed: 0,
      nCriteria: 1,
    });
    const merged = mergeRows([old], [newer]);
    expect(merged[0]!.selectedAt).toBe("t1");
    expect(merged[0]!.nPassed).toBe(0);
  });

  it("collectSelections reads mode records and remaps arm", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-judge-"));
    try {
      const task = path.join(root, "ledger-1");
      fs.mkdirSync(task);
      fs.writeFileSync(
        path.join(task, "summary.json"),
        JSON.stringify({
          selections: {
            agg: { task_id: "ledger-1", arm: "agg", k: 1, ok: true, chosen_label: "agg1" },
          },
        }),
        "utf8",
      );
      const sels = collectSelections(root, ["agg"]);
      expect(sels).toHaveLength(1);
      expect(sels[0]!.mode).toBe("agg");
      expect(sels[0]!.arm).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("write/loadRows round-trips graded fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-judge-io-"));
    try {
      const file = path.join(root, "judged.json");
      const row = new Scored({
        taskId: "t",
        mode: "agg",
        k: 1,
        label: "agg1",
        runId: "r",
        nPassed: 1,
        nCriteria: 2,
      });
      write([row], file);
      const loaded = loadRows(file);
      expect(loaded[0]!.nPassed).toBe(1);
      expect(loaded[0]!.nCriteria).toBe(2);
      expect(loaded[0]!.graded).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
