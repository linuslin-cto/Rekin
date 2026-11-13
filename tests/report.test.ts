import { describe, expect, it } from "vitest";
import { Scored } from "../src/core/judge.js";
import { render, summarise } from "../src/core/report.js";

describe("report summarise", () => {
  it("averages graded rows and excludes ungraded", () => {
    const rows = [
      new Scored({
        taskId: "a",
        mode: "agg",
        k: 1,
        label: "agg1",
        runId: "r1",
        nPassed: 1,
        nCriteria: 2,
        allPass: false,
      }),
      new Scored({
        taskId: "b",
        mode: "agg",
        k: 1,
        label: "agg1",
        runId: "r2",
        nPassed: 2,
        nCriteria: 2,
        allPass: true,
      }),
      new Scored({
        taskId: "c",
        mode: "agg",
        k: 1,
        label: "agg1",
        runId: "r3",
        error: "selection did not complete successfully",
      }),
    ];
    const [summary] = summarise(rows);
    expect(summary!.n).toBe(2);
    expect(summary!.nUngraded).toBe(1);
    expect(summary!.score).toBeCloseTo(75);
    expect(summary!.allPass).toBeCloseTo(50);
    expect(summary!.choseFinal).toBe(2);
    const text = render([summary!], "demo", "demo cell");
    expect(text).toContain("demo cell");
    expect(text).toContain("parallel k=1");
  });

  it("emits noise-floor note and base-pick warning", () => {
    const rows = [
      new Scored({
        taskId: "a",
        mode: "agg",
        k: 1,
        label: "base1",
        runId: "r1",
        chosenIsBase: true,
        nPassed: 1,
        nCriteria: 1,
        allPass: true,
      }),
      new Scored({
        taskId: "a",
        mode: "seq",
        k: 1,
        label: "c1",
        runId: "r2",
        nPassed: 1,
        nCriteria: 1,
        allPass: true,
      }),
    ];
    const text = render(summarise(rows), "demo", "cell");
    expect(text).toContain("NOISE FLOOR");
    expect(text).toContain("WARNING");
    expect(text).toContain("reference output");
  });
});
