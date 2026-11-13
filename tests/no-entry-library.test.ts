import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Reply } from "../src/core/proposer.js";
import { runDomain } from "../src/core/schedule.js";
import { DemoAdapter, DemoProposer } from "../src/demo.js";

class NoEntryProposer extends DemoProposer {
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
    if (label.startsWith("experience.")) {
      const reply: Reply = { label, text: "NO_ENTRY", ok: true, attempts: 1 };
      this._calls.push(reply);
      return reply;
    }
    return super.call(mission, contextDir, label, opts);
  }
}

describe("NO_ENTRY library gating", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("keeps library empty when reflection returns NO_ENTRY", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-noent-"));
    roots.push(root);
    const adapter = new DemoAdapter(root);
    const proposer = new NoEntryProposer(adapter.spec.channels.proposer!);
    runDomain("accounting", ["ledger-1"], 1, {
      adapter,
      prop: proposer,
      runsRoot: adapter.spec.runsRoot,
      libraryRoot: path.join(root, "library"),
      modes: ["agg"],
    });
    const lib = path.join(root, "library", "agg", "accounting", "harnesses");
    expect(fs.existsSync(lib) ? fs.readdirSync(lib) : []).toEqual([]);
  });
});
