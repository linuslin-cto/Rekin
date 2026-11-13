// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import * as tree from "./core/tree.js";
import { Proposer, type Reply } from "./core/proposer.js";
import { makeBenchPrompts, makeBenchSpec, makeChannelSpec, type ChannelSpec } from "./core/spec.js";
import { OpencodeSubstrate } from "./substrate/opencode.js";

export const BASE_SCRIPT = `import csv
import sys
from decimal import Decimal

with open(sys.argv[1]) as source:
    amounts = [Decimal(row['amount']) for row in csv.DictReader(source)]
total = sum((amount for amount in amounts if amount > 0), Decimal(0))
print(f'Total: {total:.2f}')
`;

function pythonCmd(): string {
  for (const c of ["python", "python3", "py"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c === "py" ? "py" : c;
  }
  return "python";
}

export class DemoAdapter {
  root: string;
  substrate = new OpencodeSubstrate();
  spec: ReturnType<typeof makeBenchSpec>;
  executionCount = 0;

  constructor(root: string) {
    this.root = root;
    const channel = makeChannelSpec("opencode", "local/deterministic");
    this.spec = makeBenchSpec({
      name: "demo",
      runsRoot: path.join(root, "runs"),
      installMode: "workspace_config",
      prompts: makeBenchPrompts({ work: "reconcile signed amounts in a transaction ledger" }),
      channels: { proposer: channel, selector: channel },
      leakGlobs: ["reference_answer.txt"],
    });
    const base: tree.Tree = Object.fromEntries(
      this.substrate.surface().alwaysOn.map((name) => [name, ""]),
    );
    base["systemprompt.md"] = "Reconcile the ledger using python scripts/summarize.py.\n";
    base["scripts/summarize.py"] = BASE_SCRIPT;
    tree.writeTree(this.substrate.surface(), base, this.baseHarness(), { stubs: false });
    for (const [taskId, amounts] of [
      ["ledger-1", "100.25\n-20.10\n5.00\n"],
      ["ledger-2", "35.50\n-10.25\n-5.00\n"],
    ] as const) {
      const source = this.taskFiles(taskId)!;
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, "ledger.csv"), "amount\n" + amounts, "utf8");
    }
  }

  tasks(_split = "all"): string[] {
    return ["ledger-1", "ledger-2"];
  }

  domainOf(_taskId: string): string {
    return "accounting";
  }

  taskPrompt(_taskId: string): string {
    return "Sum every signed amount in ledger.csv. Return Total: with two decimal places.";
  }

  taskFiles(taskId: string): string {
    return path.join(this.root, "sources", taskId);
  }

  baseHarness(): string {
    return path.join(this.root, "base");
  }

  validateTree(harness: tree.Tree): void {
    if (!("scripts/summarize.py" in harness)) {
      throw new Error("The local executor requires scripts/summarize.py");
    }
  }

  execute(
    taskId: string,
    harnessDir: string | null,
    runId: string,
    opts: { timeout?: number | null } = {},
  ): string {
    this.executionCount += 1;
    const runDir = path.join(this.root, "executions", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const script = path.join(harnessDir || this.baseHarness(), "scripts", "summarize.py");
    const py = pythonCmd();
    const args = py === "py" ? ["-3", script, path.join(this.taskFiles(taskId), "ledger.csv")] : [script, path.join(this.taskFiles(taskId), "ledger.csv")];
    const result = spawnSync(py, args, {
      encoding: "utf8",
      timeout: (opts.timeout ?? 10) * 1000,
      env: config.scrubEnv(),
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `python exited ${result.status}`);
    }
    const stdout = (result.stdout || "").replace(/\r\n/g, "\n");
    fs.writeFileSync(path.join(runDir, "answer.txt"), stdout, "utf8");
    fs.writeFileSync(
      path.join(runDir, "trajectory.md"),
      "[ACTION] Run scripts/summarize.py on ledger.csv\n[OBSERVATION]\n" + stdout,
      "utf8",
    );
    return runDir;
  }

  delivered(runDir: string): boolean {
    return fs.existsSync(path.join(runDir, "answer.txt"));
  }

  trajectory(runDir: string, _opts: { obsTrunc: number }): string {
    return fs.readFileSync(path.join(runDir, "trajectory.md"), "utf8");
  }

  deliverableText(runDir: string): string {
    return fs.readFileSync(path.join(runDir, "answer.txt"), "utf8");
  }

  deliverableFiles(runDir: string): Record<string, string> {
    return { "answer.txt": this.deliverableText(runDir) };
  }

  score(runDir: string, taskId: string): Record<string, unknown> | null {
    if (!this.delivered(runDir)) return null;
    const expected = `Total: ${sumCsv(path.join(this.taskFiles(taskId), "ledger.csv"))}`;
    const got = this.deliverableText(runDir).replace(/\r\n/g, "\n").trim();
    const ok = got.split("\n").some((ln) => ln.trim() === expected);
    return { n_passed: ok ? 1 : 0, n_criteria: 1, all_pass: ok, expected, got };
  }
}

function sumCsv(csvPath: string): string {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.trim().split(/\r?\n/).slice(1);
  let total = 0;
  for (const line of lines) {
    const amount = Number(line.trim());
    if (!Number.isNaN(amount)) total += amount;
  }
  return total.toFixed(2);
}

export class DemoProposer extends Proposer {
  constructor(spec: ChannelSpec) {
    super(spec);
  }

  override call(
    _mission: string,
    contextDir: string | null,
    label: string,
    _opts: {
      system?: string;
      timeout?: number | null;
      maxAttempts?: number | null;
      harvest?: string | null;
    } = {},
  ): Reply {
    const context = contextDir ? path.resolve(contextDir) : "";
    let workspace: string | null = null;
    let text = "";
    if (label.startsWith("select.")) {
      const expected = sumCsv(path.join(context, "source", "ledger.csv"));
      const candDir = path.join(context, "candidates");
      const candidates = fs
        .readdirSync(candDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      const chosen = candidates
        .map((f) => f.replace(/\.md$/, ""))
        .find((stem) =>
          fs.readFileSync(path.join(candDir, `${stem}.md`), "utf8").includes(`Total: ${expected}`),
        );
      if (!chosen) throw new Error(`no candidate matched Total: ${expected}`);
      text = `<why>The signed total matches the source ledger.</why>\n\`\`\`choice\n${chosen}\n\`\`\``;
    } else if (label.startsWith("experience.")) {
      const changed =
        fs.readFileSync(path.join(context, "harness", "scripts", "summarize.py"), "utf8") !==
        fs.readFileSync(path.join(context, "base_harness", "scripts", "summarize.py"), "utf8");
      text =
        "<edits>\ncomponent: scripts/summarize.py\ncandidates: inv1\n" +
        "change: dropped the positive-only filter from the amount sum\n" +
        "observed: the probe total included the credits the base run omitted\n" +
        `verdict: ${changed ? "helped" : "no observed effect"}\n</edits>\n\n` +
        (changed
          ? "<experience>\ncue: When a ledger includes credits and debits\n" +
            "lesson: Include both signs when summing in scripts/summarize.py.\n" +
            "evidence: The scripts/summarize.py row -- removing the positive-only filter " +
            "changed the probe total to include the credits omitted by the base trajectory.\n" +
            "confidence: high for this observed arithmetic contrast\n</experience>"
          : "NO_ENTRY");
    } else {
      workspace = path.join(context, "harness");
      const script = path.join(workspace, "scripts", "summarize.py");
      const body = fs.readFileSync(script, "utf8").replace(" if amount > 0", "");
      fs.writeFileSync(script, body, "utf8");
      text =
        "<notes>Keep signed amounts: the base total omitted credits in the source ledger.</notes>";
    }
    const reply: Reply = {
      label,
      text,
      ok: true,
      attempts: 1,
      workspace,
      channel: this.spec.kind,
    };
    this._calls.push(reply);
    return reply;
  }
}
