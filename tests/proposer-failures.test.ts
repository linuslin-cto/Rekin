import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposerError, type Reply } from "../src/core/proposer.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";
import type { ChannelSpec } from "../src/core/spec.js";

class FirstCandidateSelector extends DemoProposer {
  override call(
    mission: string,
    contextDir: string | null,
    label: string,
    opts: {
      system?: string;
      timeout?: number | null;
      maxAttempts?: number | null;
      harvest?: string | null;
    } = {},
  ): Reply {
    if (label.startsWith("select.")) {
      const candDir = path.join(contextDir!, "candidates");
      const chosen = fs
        .readdirSync(candDir)
        .filter((f) => f.endsWith(".md"))
        .sort()[0]!
        .replace(/\.md$/, "");
      const reply: Reply = {
        label,
        text: `\`\`\`choice\n${chosen}\n\`\`\``,
        ok: true,
        attempts: 1,
      };
      this._calls.push(reply);
      return reply;
    }
    return super.call(mission, contextDir, label, opts);
  }
}

class OutageProposer extends DemoProposer {
  override call(): Reply {
    throw new ProposerError("offline outage", { attempts: 2, costUsd: 0.25 });
  }
}

describe("proposer failure resume", () => {
  let root: string;
  let adapter: DemoAdapter;
  let spec: ChannelSpec;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-outage-"));
    adapter = new DemoAdapter(root);
    spec = adapter.spec.channels.proposer!;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runStream(k: number, proposer: DemoProposer, selector: DemoProposer) {
    return runDomain("accounting", adapter.tasks(), k, {
      adapter,
      prop: proposer,
      selectorProp: selector,
      runsRoot: adapter.spec.runsRoot,
      libraryRoot: path.join(root, "library", String(k)),
    });
  }

  it("outage is partial then healthy rerun succeeds and skips", () => {
    for (const k of [1, 2]) {
      const selector = new FirstCandidateSelector(spec);
      const executions = adapter.executionCount;
      const failed = runStream(k, new OutageProposer(spec), selector);
      expect(failed.done).toBe(0);
      expect(failed.failed).toBe(2);
      expect((failed.tasks as { status: string }[]).map((t) => t.status)).toEqual([
        "partial",
        "partial",
      ]);
      for (const taskId of adapter.tasks()) {
        const summary = JSON.parse(
          fs.readFileSync(
            path.join(adapter.spec.runsRoot, `demo-oc-agg${k}`, taskId, "summary.json"),
            "utf8",
          ),
        );
        expect(summary.status).toBe("partial");
        expect(summary.errors).toHaveLength(6 * k);
        for (const mode of ["agg", "seq"]) {
          const record = summary.modes[mode];
          expect(record.ok).toBe(false);
          expect(summary.selections[mode].ok).toBe(true);
          for (const stage of record.stages) {
            expect(stage.execution_failed).toBe(true);
            expect(stage.fell_back).toBe(true);
            expect(stage.cached).toBe(false);
            expect([stage.attempts, stage.usd]).toEqual([2, 0.25]);
            expect(
              summary.errors.some(
                (e: string) =>
                  e.includes(`${mode}: ${stage.label}: proposer execution failed:`) &&
                  e.includes("offline outage"),
              ),
            ).toBe(true);
          }
          const ledger = record.ledger;
          expect([ledger.R, ledger.P]).toEqual([4 * k, 3 * k]);
          expect(ledger.session_attempts).toBe(6 * k);
          expect(ledger.session_usd).toBeCloseTo(0.75 * k);
          expect(adapter.delivered(summary.selections[mode].chosen_run_dir)).toBe(true);
        }
      }
      expect(adapter.executionCount - executions).toBe(14 * k);

      const proposer = new DemoProposer(spec);
      const recovered = runStream(k, proposer, selector);
      expect(recovered.done).toBe(2);
      expect((recovered.tasks as { status: string }[]).map((t) => t.status)).toEqual([
        "ok",
        "ok",
      ]);
      const again = runStream(k, proposer, selector);
      expect((again.tasks as { status: string }[]).map((t) => t.status)).toEqual([
        "skipped",
        "skipped",
      ]);
    }
  });
});
