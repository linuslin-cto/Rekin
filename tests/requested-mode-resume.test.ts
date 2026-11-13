import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposerError, type Reply } from "../src/core/proposer.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

describe("requested mode resume", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("valid parallel mode resumes when sequential selection failed", () => {
    class SequentialFailure extends DemoProposer {
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
        if (label === "select.seq2") {
          throw new ProposerError("temporary sequential selector failure", { attempts: 1 });
        }
        return super.call(mission, contextDir, label, opts);
      }
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-mode-"));
    roots.push(root);
    const adapter = new DemoAdapter(root);
    const proposer = new SequentialFailure(adapter.spec.channels.proposer!);

    const run = (modes: readonly string[]) =>
      runDomain("accounting", ["ledger-1"], 2, {
        adapter,
        prop: proposer,
        runsRoot: adapter.spec.runsRoot,
        libraryRoot: path.join(root, "library"),
        modes,
      });

    expect((run(["agg", "seq"]).tasks as { status: string }[])[0]!.status).toBe("partial");
    const record = JSON.parse(
      fs.readFileSync(
        path.join(adapter.spec.runsRoot, "demo-oc-agg2", "ledger-1", "summary.json"),
        "utf8",
      ),
    );
    expect(record.selections.agg.ok).toBe(true);
    expect(record.selections.seq.ok).toBe(false);

    const counts = [adapter.executionCount, proposer._calls.length] as const;
    for (let i = 0; i < 2; i++) {
      expect((run(["agg"]).tasks as { status: string }[])[0]!.status).toBe("skipped");
      expect([adapter.executionCount, proposer._calls.length]).toEqual([...counts]);
    }
    expect((run(["seq"]).tasks as { status: string }[])[0]!.status).toBe("partial");
    expect(adapter.executionCount).toBeGreaterThan(counts[0]);
  });
});
