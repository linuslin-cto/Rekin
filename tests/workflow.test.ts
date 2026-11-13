import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as config from "../src/config.js";
import { assertTreeHasNoGraderVerdicts } from "../src/core/context.js";
import { Proposer } from "../src/core/proposer.js";
import { resolveChannelModel } from "../src/core/spec.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("workflow contracts", () => {
  let root: string;
  let adapter: DemoAdapter;
  let proposer: DemoProposer;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-ts-"));
    adapter = new DemoAdapter(root);
    proposer = new DemoProposer(adapter.spec.channels.proposer!);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runStream(k = 2, prop: DemoProposer = proposer) {
    return runDomain("accounting", adapter.tasks(), k, {
      adapter,
      prop,
      runsRoot: adapter.spec.runsRoot,
      libraryRoot: path.join(root, "library", String(k)),
    });
  }

  it("enforces channel model resolution", () => {
    const prev = { ...config.PROPOSER_MODEL_BY_CHANNEL };
    config.PROPOSER_MODEL_BY_CHANNEL.opencode = "";
    config.PROPOSER_MODEL_BY_CHANNEL.claude_cli = "";
    try {
      const unresolved = resolveChannelModel(null, null);
      expect(unresolved.model).toBe("");
      expect(() => new Proposer(unresolved)).toThrow();
      expect(() => resolveChannelModel("opencode", "")).toThrow();
    } finally {
      Object.assign(config.PROPOSER_MODEL_BY_CHANNEL, prev);
    }
  });

  it("meets recursion budget and resume", () => {
    for (const k of [1, 2]) {
      const result = runStream(k);
      expect(result.done).toBe(2);
      expect(result.failed).toBe(0);
      for (const taskId of adapter.tasks()) {
        const summary = JSON.parse(
          fs.readFileSync(
            path.join(adapter.spec.runsRoot, `demo-oc-agg${k}`, taskId, "summary.json"),
            "utf8",
          ),
        );
        for (const mode of ["agg", "seq"]) {
          const ledger = summary.modes[mode].ledger;
          expect(ledger.R).toBe(4 * k);
          expect(ledger.P).toBe(3 * k);
          const selection = summary.selections[mode];
          const expected = taskId === "ledger-1" ? "Total: 85.15\n" : "Total: 20.25\n";
          expect(adapter.deliverableText(selection.chosen_run_dir)).toBe(expected);
        }
      }
      const executions = adapter.executionCount;
      const calls = proposer._calls.length;
      const resumed = runStream(k);
      expect(adapter.executionCount).toBe(executions);
      expect(proposer._calls.length).toBe(calls);
      expect((resumed.tasks as { status: string }[]).map((t) => t.status)).toEqual([
        "skipped",
        "skipped",
      ]);
    }
  });

  it("writes complete evidence and library prefix", () => {
    fs.writeFileSync(
      path.join(adapter.taskFiles("ledger-1"), "reference_answer.txt"),
      '"pass_rate": 1',
      "utf8",
    );
    runStream(2);
    const work = path.join(adapter.spec.runsRoot, "demo-oc-seq2", "ledger-1");
    const reflection = path.join(work, "reflection", "seq2");
    const required = [
      "source/ledger.csv",
      "rollouts/base1.md",
      "rollouts/c2.md",
      "pool/inv1/harness.diff",
      "decisions/c1.md",
      "adoption.json",
      "base_harness/scripts/summarize.py",
      "harness/scripts/summarize.py",
    ];
    expect(required.filter((name) => !fs.existsSync(path.join(reflection, name)))).toEqual([]);
    expect(fs.existsSync(path.join(work, "context", "inv2", "pool", "c1", "rollout.md"))).toBe(
      true,
    );
    expect(
      [...walkFiles(work)].filter((p) => p.endsWith("reference_answer.txt")),
    ).toEqual([]);
    const nextContext = path.join(
      work,
      "..",
      "ledger-2",
      "context",
      "inv1",
      "library",
      "harnesses",
    );
    expect(fs.readdirSync(nextContext)).toEqual(["ledger-1"]);
    expect(() =>
      assertTreeHasNoGraderVerdicts({ "EXPERIENCE.md": '"pass_rate": 1' }),
    ).toThrow();
  });
});

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!fs.existsSync(cur)) continue;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}
