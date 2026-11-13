import { describe, expect, it } from "vitest";
import { assignIds } from "../src/core/selection.js";

describe("assignIds", () => {
  it("is stable for the same task/k/mode", () => {
    const labels = ["agg2", "agg1", "base1"];
    const a = assignIds(labels, { taskId: "t1", k: 2, mode: "agg" });
    const b = assignIds(labels, { taskId: "t1", k: 2, mode: "agg" });
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(["A", "B", "C"]);
  });

  it("matches CPython random.Random.shuffle fixtures", () => {
    const fixtures: Array<{
      labels: string[];
      taskId: string;
      k: number;
      mode: string;
      map: Record<string, string>;
    }> = [
      {
        labels: ["agg1", "agg2"],
        taskId: "t1",
        k: 2,
        mode: "agg",
        map: { A: "agg1", B: "agg2" },
      },
      {
        labels: ["agg1", "agg2", "agg3", "base1"],
        taskId: "t1",
        k: 2,
        mode: "agg",
        map: { A: "agg1", B: "base1", C: "agg2", D: "agg3" },
      },
      {
        labels: ["a1", "a2", "a3", "a4", "a5", "a6"],
        taskId: "t1",
        k: 2,
        mode: "agg",
        map: { A: "a1", B: "a2", C: "a6", D: "a4", E: "a3", F: "a5" },
      },
      {
        labels: ["a1", "a2", "a3", "a4", "a5", "a6"],
        taskId: "t1",
        k: 2,
        mode: "seq",
        map: { A: "a2", B: "a1", C: "a4", D: "a3", E: "a5", F: "a6" },
      },
      {
        labels: ["c1", "c2", "c3"],
        taskId: "contracts/task-1",
        k: 3,
        mode: "seq",
        map: { A: "c3", B: "c2", C: "c1" },
      },
    ];
    for (const fx of fixtures) {
      expect(assignIds(fx.labels, { taskId: fx.taskId, k: fx.k, mode: fx.mode })).toEqual(fx.map);
    }
  });
});
