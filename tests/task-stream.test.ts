import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSweep, taskStream } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("taskStream / runSweep", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("filters domains and max tasks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-stream-"));
    roots.push(root);
    const adapter = new DemoAdapter(root);
    expect(taskStream(adapter)).toEqual({ accounting: ["ledger-1", "ledger-2"] });
    expect(taskStream(adapter, { maxTasks: 1 })).toEqual({ accounting: ["ledger-1"] });
    expect(taskStream(adapter, { onlyTasks: ["ledger-2"] })).toEqual({
      accounting: ["ledger-2"],
    });
  });

  it("runSweep executes filtered stream", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-sweep-"));
    roots.push(root);
    const adapter = new DemoAdapter(root);
    const proposer = new DemoProposer(adapter.spec.channels.proposer!);
    const result = runSweep(1, {
      adapter,
      prop: proposer,
      runsRoot: adapter.spec.runsRoot,
      libraryRoot: path.join(root, "library"),
      onlyTasks: ["ledger-1"],
      modes: ["agg"],
    });
    expect(result.n_domains).toBe(1);
    expect(result.domain_order).toEqual(["accounting"]);
    const domain = (result.domains as Record<string, unknown>[])[0]!;
    expect(domain.done).toBe(1);
    expect(domain.failed).toBe(0);
  });
});
