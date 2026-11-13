import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStage } from "../src/core/recursion.js";
import { Proposer, type Reply } from "../src/core/proposer.js";
import * as tree from "../src/core/tree.js";
import { DemoAdapter } from "../src/demo.js";

class RetryProposer extends Proposer {
  seen: string[] = [];
  missions: string[] = [];
  defect: string;
  extra: string;

  constructor(spec: DemoAdapter["spec"]["channels"]["proposer"], defect: string, extra: string) {
    super(spec!);
    this.defect = defect;
    this.extra = extra;
  }

  override call(
    mission: string,
    contextDir: string | null,
    label: string,
  ): Reply {
    this.missions.push(mission);
    const harness = path.join(contextDir!, "harness");
    const script = path.join(harness, "scripts", "summarize.py");
    this.seen.push(fs.readFileSync(script, "utf8"));
    if (!mission.includes("PREVIOUS ATTEMPT WAS REJECTED")) {
      const defectPath = path.join(harness, this.defect);
      fs.mkdirSync(path.dirname(defectPath), { recursive: true });
      fs.writeFileSync(defectPath, this.extra, "utf8");
      fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace(" if amount > 0", ""), "utf8");
    } else if (fs.existsSync(path.join(harness, this.defect))) {
      fs.unlinkSync(path.join(harness, this.defect));
    }
    return {
      label,
      text: "<notes>Keep signed amounts.</notes>",
      ok: true,
      attempts: 1,
      costUsd: 0,
      workspace: harness,
    };
  }
}

describe("stage retry", () => {
  let root: string;
  let adapter: DemoAdapter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-retry-"));
    adapter = new DemoAdapter(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runOne(defect: string, extra: string) {
    const work = path.join(root, defect.replace(/\//g, "_"));
    const prop = new RetryProposer(adapter.spec.channels.proposer, defect, extra);
    const stage = runStage({
      label: "inv1",
      dim: "INV",
      job: "Repair the script",
      adapter,
      prop,
      ctxDir: path.join(work, "context"),
      taskId: "ledger-1",
      rollouts: [],
      fallback: tree.readTree(adapter.substrate.surface(), adapter.baseHarness()),
      harnessDir: adapter.baseHarness(),
      libraryDir: null,
    });
    return { stage, seen: prop.seen, missions: prop.missions };
  }

  it("retry keeps the rejected attempt edits", () => {
    for (const [defect, extra] of [
      ["scripts/check.py", "def broken(:\n"],
      ["scripts/summarize.py.bak", "# an editor's backup, off the editable surface\n"],
    ] as const) {
      const { stage, seen, missions } = runOne(defect, extra);
      expect(missions[1]).toContain(defect);
      expect(seen[1]).not.toContain(" if amount > 0");
      expect([stage.fellBack, stage.keptBase, stage.attempts]).toEqual([false, false, 2]);
      expect(stage.tree["scripts/summarize.py"]).not.toContain(" if amount > 0");
      expect(stage.tree).not.toHaveProperty(defect);
    }
  });
});
