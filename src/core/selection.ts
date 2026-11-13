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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as context from "./context.js";
import * as prompts from "./prompts.js";
import { Proposer, ProposerError } from "./proposer.js";
import { PyRandom } from "./py-random.js";
import type { BenchmarkAdapter, RunView } from "./spec.js";
import { resolvePrompts } from "./spec.js";
import * as harnessTree from "./tree.js";

const CHOICE = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?\s*```/s;
const WHY = /<why>([\s\S]*?)<\/why>/;
const EXP = /<experience>([\s\S]*?)<\/experience>/;
const EDITS = /<edits>([\s\S]*?)<\/edits>/;

export class Selection {
  taskId: string;
  mode: string;
  k: number;
  chosenId = "";
  chosenLabel = "";
  chosenRunId = "";
  chosenIsBase = false;
  why = "";
  idMap: Record<string, string> = {};
  dropped: string[] = [];
  nCandidates = 0;
  ok = false;
  fallback = false;
  error = "";
  usd = 0;
  experience: Record<string, unknown> = {};
  trivial = false;
  evidence = "deliverable";

  constructor(taskId: string, mode: string, k: number) {
    this.taskId = taskId;
    this.mode = mode;
    this.k = k;
  }

  toDict(): Record<string, unknown> {
    return {
      task_id: this.taskId,
      mode: this.mode,
      k: this.k,
      chosen_id: this.chosenId,
      chosen_label: this.chosenLabel,
      chosen_run_id: this.chosenRunId,
      chosen_is_base: this.chosenIsBase,
      why: this.why,
      id_map: this.idMap,
      dropped: this.dropped,
      n_candidates: this.nCandidates,
      ok: this.ok,
      fallback: this.fallback,
      error: this.error,
      usd: this.usd,
      experience: this.experience,
      trivial: this.trivial,
      evidence: this.evidence,
    };
  }
}

function anonId(index: number): string {
  let out = "";
  let n = index + 1;
  while (n) {
    const rem = (n - 1) % 26;
    n = Math.floor((n - 1) / 26);
    out = String.fromCharCode("A".charCodeAt(0) + rem) + out;
  }
  return out;
}

export function assignIds(
  labels: readonly string[],
  opts: { taskId: string; k: number; mode: string },
): Record<string, string> {
  // Match harness2: sha1 hex[:12] -> int, then CPython Random(seed).shuffle.
  const seed = Number.parseInt(
    crypto.createHash("sha1").update(`${opts.taskId}|${opts.k}|${opts.mode}`).digest("hex").slice(0, 12),
    16,
  );
  const ordered = [...labels].sort();
  new PyRandom(seed).shuffle(ordered);
  const out: Record<string, string> = {};
  ordered.forEach((lbl, i) => {
    out[anonId(i)] = lbl;
  });
  return out;
}

export function selectionPool(
  mode: string,
  k: number,
  rollouts: Record<string, RunView>,
  _base: readonly RunView[],
): Record<string, RunView> {
  const labels =
    mode === "agg"
      ? Array.from({ length: k }, (_, i) => `agg${i + 1}`)
      : Array.from({ length: k }, (_, i) => `c${i + 1}`);
  const out: Record<string, RunView> = {};
  for (const lbl of labels) {
    if (lbl in rollouts) out[lbl] = rollouts[lbl]!;
  }
  return out;
}

export function trivialSelection(
  taskId: string,
  k: number,
  mode: string,
  candidates: Record<string, RunView>,
  opts: { adapter: BenchmarkAdapter; workDir: string },
): Selection {
  const sel = new Selection(taskId, mode, k);
  sel.trivial = true;
  const labels = Object.keys(candidates);
  if (!labels.length) {
    sel.error = "no candidates";
    return sel;
  }
  const label = labels[0]!;
  const rv = candidates[label]!;
  sel.chosenLabel = label;
  sel.chosenRunId = rv.runId;
  sel.chosenId = "A";
  sel.idMap = { A: label };
  sel.nCandidates = 1;
  sel.ok = rv.ok && rv.delivered;
  sel.why = "k=1 trivial selection";
  sel.chosenIsBase = label.startsWith("base");
  void opts;
  return sel;
}

export function runSelection(
  taskId: string,
  k: number,
  mode: string,
  candidates: Record<string, RunView>,
  opts: { adapter: BenchmarkAdapter; prop: Proposer; workDir: string; poolKind?: string },
): Selection {
  const sel = new Selection(taskId, mode, k);
  const pool: Record<string, RunView> = {};
  const artifacts: Record<string, string> = {};
  for (const [lbl, rv] of Object.entries(candidates)) {
    if (!(rv.ok && rv.delivered)) {
      sel.dropped.push(lbl);
      continue;
    }
    try {
      const rendered = opts.adapter.deliverableText(rv.runDir) || "";
      if (!rendered.trim()) {
        sel.dropped.push(lbl);
        continue;
      }
      pool[lbl] = rv;
      artifacts[lbl] = rendered;
    } catch (exc) {
      sel.dropped.push(`${lbl} (render failed: ${exc instanceof Error ? exc.message : String(exc)})`);
    }
  }
  sel.nCandidates = Object.keys(pool).length;
  if (!sel.nCandidates) {
    sel.error = "no deliverable candidates";
    return sel;
  }

  sel.idMap = assignIds(Object.keys(pool), { taskId, k, mode });
  const ctx = path.join(opts.workDir, "selection", mode);
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(path.join(ctx, "candidates"), { recursive: true });
  // DemoProposer reads source/ledger.csv — copy task source into selection context.
  context.copySource(opts.adapter, taskId, ctx);
  for (const [anon, label] of Object.entries(sel.idMap)) {
    fs.writeFileSync(path.join(ctx, "candidates", `${anon}.md`), artifacts[label]!, "utf8");
  }
  const mission = prompts.select(resolvePrompts(opts.adapter, taskId), sel.nCandidates, {
    poolKind: opts.poolKind,
  });
  try {
    const reply = opts.prop.call(mission, ctx, `select.${mode}${k}`, {});
    sel.usd += reply.costUsd ?? 0;
    const m = reply.text.match(CHOICE);
    const why = reply.text.match(WHY);
    if (!m) {
      sel.error = "no ```choice``` in selector reply";
      return sel;
    }
    const chosenId = m[1]!;
    const label = sel.idMap[chosenId];
    if (!label || !(label in pool)) {
      sel.error = `choice ${chosenId} not in pool`;
      return sel;
    }
    sel.chosenId = chosenId;
    sel.chosenLabel = label;
    sel.chosenRunId = pool[label]!.runId;
    sel.why = why ? why[1]!.trim() : "";
    sel.chosenIsBase = label.startsWith("base");
    sel.ok = true;
  } catch (exc) {
    sel.error = exc instanceof ProposerError ? exc.message : String(exc);
  }
  return sel;
}

export function reflectAdoption(
  taskId: string,
  sel: Selection,
  rollouts: Record<string, RunView>,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    workDir: string;
    decisions?: Record<string, string>;
  },
): void {
  if (!sel.ok || !sel.chosenLabel) return;
  const chosen = rollouts[sel.chosenLabel];
  if (!chosen) return;
  const surface = opts.adapter.substrate.surface();
  const harnesses = path.join(opts.workDir, "harnesses");
  const harnessDir = path.join(harnesses, sel.chosenLabel);
  const baseDir = path.join(harnesses, "base");
  const ctx = path.join(opts.workDir, "reflection", `${sel.mode}${sel.k}`);
  const pool = Object.entries(rollouts)
    .filter(([label]) => !label.startsWith("base"))
    .map(
      ([label, rollout]) =>
        [label, path.join(harnesses, label), rollout] as const,
    );
  const tree = context.build(ctx, opts.adapter, taskId, Object.values(rollouts), {
    harnessDir: fs.existsSync(harnessDir) ? harnessDir : null,
    pool,
    decisions: opts.decisions ?? null,
  });
  if (fs.existsSync(baseDir)) {
    fs.cpSync(baseDir, path.join(tree.root, "base_harness"), { recursive: true });
  } else {
    const baseTree = harnessTree.readTree(surface, opts.adapter.baseHarness());
    harnessTree.writeTree(surface, baseTree, path.join(tree.root, "base_harness"), {
      stubs: false,
    });
  }
  fs.writeFileSync(
    path.join(tree.root, "adoption.json"),
    JSON.stringify(
      {
        chosen_label: sel.chosenLabel,
        candidate_ids: sel.idMap,
        reason: sel.why,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const mission = prompts.experience(resolvePrompts(opts.adapter, taskId));
  try {
    const reply = opts.prop.call(mission, tree.root, `experience.${sel.mode}${sel.k}`, {});
    sel.usd += reply.costUsd ?? 0;
    if (reply.text.trim() === "NO_ENTRY" || !EXP.test(reply.text)) {
      sel.experience = {};
      return;
    }
    const exp = reply.text.match(EXP);
    const edits = reply.text.match(EDITS);
    const out: Record<string, unknown> = {};
    for (const line of (exp?.[1] ?? "").trim().split(/\r?\n/)) {
      if (!line.includes(":")) continue;
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (["cue", "lesson", "evidence", "confidence"].includes(key)) out[key] = val;
    }
    if (!(["cue", "lesson", "evidence"] as const).every((k) => out[k])) {
      sel.experience = {};
      return;
    }
    if (edits) {
      out.edits = edits[1]!.trim();
      fs.writeFileSync(path.join(tree.root, "edits.md"), edits[1]!.trim() + "\n", "utf8");
    }
    sel.experience = out;
  } catch (exc) {
    if (exc instanceof ProposerError) sel.usd += exc.costUsd;
    sel.experience = {};
  }
}
