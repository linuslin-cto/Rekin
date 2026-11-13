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

/** Measurement of the run that selection chose, after it chose it. */

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkAdapter } from "./spec.js";

export function hasGrade(nPassed: number | null | undefined, nCriteria: number | null | undefined): boolean {
  return nPassed != null && nCriteria != null && nCriteria > 0;
}

export class Scored {
  taskId: string;
  mode: string;
  k: number;
  label: string;
  runId: string;
  chosenIsBase: boolean;
  selectedAt: string;
  nPassed: number | null;
  nCriteria: number | null;
  allPass: boolean;
  raw: Record<string, unknown>;
  error: string;

  constructor(init: {
    taskId: string;
    mode: string;
    k: number;
    label: string;
    runId: string;
    chosenIsBase?: boolean;
    selectedAt?: string;
    nPassed?: number | null;
    nCriteria?: number | null;
    allPass?: boolean;
    raw?: Record<string, unknown>;
    error?: string;
  }) {
    this.taskId = init.taskId;
    this.mode = init.mode;
    this.k = init.k;
    this.label = init.label;
    this.runId = init.runId;
    this.chosenIsBase = init.chosenIsBase ?? false;
    this.selectedAt = init.selectedAt ?? "";
    this.nPassed = init.nPassed ?? null;
    this.nCriteria = init.nCriteria ?? null;
    this.allPass = init.allPass ?? false;
    this.raw = init.raw ?? {};
    this.error = init.error ?? "";
  }

  get graded(): boolean {
    return hasGrade(this.nPassed, this.nCriteria);
  }

  get frac(): number | null {
    return this.graded ? this.nPassed! / this.nCriteria! : null;
  }

  toDict(): Record<string, unknown> {
    return {
      task_id: this.taskId,
      mode: this.mode,
      k: this.k,
      label: this.label,
      run_id: this.runId,
      chosen_is_base: this.chosenIsBase,
      selected_at: this.selectedAt,
      n_passed: this.nPassed,
      n_criteria: this.nCriteria,
      all_pass: this.allPass,
      raw: this.raw,
      error: this.error,
      frac: this.frac,
      graded: this.graded,
    };
  }
}

function modeOf(sel: Record<string, unknown>): string {
  return String("mode" in sel ? sel.mode : sel.arm || "");
}

export function judgeOne(
  adapter: BenchmarkAdapter,
  taskId: string,
  mode: string,
  k: number,
  label: string,
  runId: string,
  runDir: string,
  opts: { chosenIsBase?: boolean; selectedAt?: string } = {},
): Scored {
  const s = new Scored({
    taskId,
    mode,
    k,
    label,
    runId,
    chosenIsBase: opts.chosenIsBase ?? false,
    selectedAt: opts.selectedAt ?? "",
  });
  try {
    const got = adapter.score(runDir, taskId);
    if (!got) {
      s.error = "judge returned nothing";
      return s;
    }
    s.raw = { ...got };
    s.nPassed = (got.n_passed as number | null | undefined) ?? null;
    s.nCriteria = (got.n_criteria as number | null | undefined) ?? null;
    s.allPass = Boolean(
      got.all_pass ?? (s.graded && s.nPassed === s.nCriteria),
    );
    return s;
  } catch (exc) {
    s.error = `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`;
    return s;
  }
}

export function judgeSelections(
  adapter: BenchmarkAdapter,
  selections: readonly Record<string, unknown>[],
  _opts: { parallel?: number } = {},
): Scored[] {
  const out: Scored[] = [];
  for (const sel of selections) {
    const rd = sel.chosen_run_dir;
    if (!sel.ok || !sel.chosen_label || !rd) {
      out.push(
        new Scored({
          taskId: String(sel.task_id ?? ""),
          mode: modeOf(sel),
          k: Number(sel.k ?? 0),
          label: String(sel.chosen_label ?? ""),
          runId: String(sel.chosen_run_id ?? ""),
          chosenIsBase: Boolean(sel.chosen_is_base),
          selectedAt: String(sel.selected_at ?? ""),
          error: "selection did not complete successfully",
        }),
      );
      continue;
    }
    out.push(
      judgeOne(
        adapter,
        String(sel.task_id),
        modeOf(sel),
        Number(sel.k),
        String(sel.chosen_label),
        String(sel.chosen_run_id ?? ""),
        String(rd),
        {
          chosenIsBase: Boolean(sel.chosen_is_base),
          selectedAt: String(sel.selected_at ?? ""),
        },
      ),
    );
  }
  return out;
}

export function write(rows: readonly Scored[], filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      rows.map((r) => r.toDict()),
      null,
      2,
    ),
    "utf8",
  );
  return filePath;
}

const DERIVED = new Set(["frac", "graded"]);

export function scoredFromDict(row: Record<string, unknown>): Scored {
  const raw = { ...row };
  for (const k of DERIVED) delete raw[k];
  if (!("mode" in raw) && "arm" in raw) {
    raw.mode = raw.arm;
    delete raw.arm;
  }
  return new Scored({
    taskId: String(raw.task_id ?? raw.taskId ?? ""),
    mode: String(raw.mode ?? ""),
    k: Number(raw.k ?? 0),
    label: String(raw.label ?? ""),
    runId: String(raw.run_id ?? raw.runId ?? ""),
    chosenIsBase: Boolean(raw.chosen_is_base ?? raw.chosenIsBase),
    selectedAt: String(raw.selected_at ?? raw.selectedAt ?? ""),
    nPassed: (raw.n_passed as number | null | undefined) ?? (raw.nPassed as number | null | undefined) ?? null,
    nCriteria:
      (raw.n_criteria as number | null | undefined) ?? (raw.nCriteria as number | null | undefined) ?? null,
    allPass: Boolean(raw.all_pass ?? raw.allPass),
    raw: (raw.raw as Record<string, unknown>) ?? {},
    error: String(raw.error ?? ""),
  });
}

export function loadRows(filePath: string): Scored[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>[];
    return raw.map((row) => scoredFromDict(row));
  } catch (exc) {
    throw new Error(
      `unreadable judged cache ${filePath}: ${exc instanceof Error ? exc.message : String(exc)}; move it aside to rebuild`,
    );
  }
}

/** Graded rows win over failed re-judges of the same selection; a new pick replaces. */
export function mergeRows(oldRows: readonly Scored[], newRows: readonly Scored[]): Scored[] {
  const byKey = new Map<string, Scored>();
  const keyOf = (r: Scored) => `${r.taskId}\0${r.mode}\0${r.k}`;
  for (const r of oldRows) byKey.set(keyOf(r), r);
  for (const r of newRows) {
    const key = keyOf(r);
    const prev = byKey.get(key);
    if (
      prev &&
      prev.runId === r.runId &&
      prev.selectedAt === r.selectedAt &&
      prev.graded &&
      !r.graded &&
      !r.error.startsWith("selection")
    ) {
      continue;
    }
    byKey.set(key, r);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, r]) => r);
}

export function selectionRecord(sel: Record<string, unknown>): Record<string, unknown> {
  if (!("mode" in sel) && "arm" in sel) {
    const out = { ...sel };
    out.mode = out.arm;
    delete out.arm;
    return out;
  }
  return sel;
}

export function collectSelections(nsDir: string, modes: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (!fs.existsSync(nsDir)) return out;
  const tasks = fs
    .readdirSync(nsDir)
    .map((name) => path.join(nsDir, name, "summary.json"))
    .filter((p) => fs.existsSync(p))
    .sort();
  for (const summaryPath of tasks) {
    let summary: Record<string, unknown>;
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      console.log(`  ! skipping unreadable ${summaryPath}: ${exc}`);
      continue;
    }
    const selections = (summary.selections as Record<string, Record<string, unknown>>) || {};
    for (const mode of modes) {
      const sel = selections[mode];
      if (sel) out.push(selectionRecord(sel));
    }
  }
  return out;
}
