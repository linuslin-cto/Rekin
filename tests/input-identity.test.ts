import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("task input identity resume", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("re-runs when source material changes under the same task id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-id-"));
    roots.push(root);
    const adapter = new DemoAdapter(root);
    const proposer = new DemoProposer(adapter.spec.channels.proposer!);
    const run = () =>
      runDomain("accounting", ["ledger-1"], 1, {
        adapter,
        prop: proposer,
        runsRoot: adapter.spec.runsRoot,
        libraryRoot: path.join(root, "library"),
        modes: ["agg"],
      });

    expect((run().tasks as { status: string }[])[0]!.status).toBe("ok");
    const counts = [adapter.executionCount, proposer._calls.length] as const;
    expect((run().tasks as { status: string }[])[0]!.status).toBe("skipped");
    expect([adapter.executionCount, proposer._calls.length]).toEqual([...counts]);

    fs.writeFileSync(
      path.join(adapter.taskFiles("ledger-1"), "ledger.csv"),
      "amount\n1.00\n-0.50\n",
      "utf8",
    );
    expect((run().tasks as { status: string }[])[0]!.status).toBe("ok");
    expect(adapter.executionCount).toBeGreaterThan(counts[0]);
  });
});
