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

/** Judged selections -> the figure each benchmark reports. */

import fs from "node:fs";
import path from "node:path";
import { MODE_NAMES } from "./schedule.js";
import type { Scored } from "./judge.js";

export class Summary {
  mode: string;
  k: number;
  n: number;
  nUngraded: number;
  score: number | null;
  allPass: number | null;
  keptBase: number;
  choseFinal: number;
  choseCandidate: number;
  fellBack: number;
  usd: number;
  metrics: readonly string[];

  constructor(init: {
    mode: string;
    k: number;
    n?: number;
    nUngraded?: number;
    score?: number | null;
    allPass?: number | null;
    keptBase?: number;
    choseFinal?: number;
    choseCandidate?: number;
    fellBack?: number;
    usd?: number;
    metrics?: readonly string[];
  }) {
    this.mode = init.mode;
    this.k = init.k;
    this.n = init.n ?? 0;
    this.nUngraded = init.nUngraded ?? 0;
    this.score = init.score ?? null;
    this.allPass = init.allPass ?? null;
    this.keptBase = init.keptBase ?? 0;
    this.choseFinal = init.choseFinal ?? 0;
    this.choseCandidate = init.choseCandidate ?? 0;
    this.fellBack = init.fellBack ?? 0;
    this.usd = init.usd ?? 0;
    this.metrics = init.metrics ?? [];
  }

  get name(): string {
    return `${MODE_NAMES[this.mode as keyof typeof MODE_NAMES] ?? this.mode} k=${this.k}`;
  }

  line(bench = ""): string {
    if (!this.n) return `  ${this.name}: no graded task`;
    const figures =
      bench === "lab"
        ? `partial ${this.score!.toFixed(2).padStart(6)}% | pass ${this.allPass!.toFixed(1).padStart(5)}%`
        : `score ${this.score!.toFixed(2).padStart(6)}%`;
    const pick = ` | picked output: final ${this.choseFinal} / candidate ${this.choseCandidate} / base ${this.keptBase}`;
    const fb = this.fellBack ? ` | fell back ${this.fellBack}` : "";
    const ug = this.nUngraded ? ` | ungraded ${this.nUngraded}` : "";
    return `  ${this.name}: n=${String(this.n).padStart(3)} | ${figures}${pick}${fb}${ug}`;
  }
}

function kind(r: Scored): string {
  const lbl = String(r.label || "");
  if (lbl.startsWith("base")) return "base";
  if (r.mode === "agg") return lbl.startsWith("agg") ? "final" : "candidate";
  if (r.mode === "seq") {
    const finals = new Set(Array.from({ length: r.k }, (_, i) => `c${i + 1}`));
    return finals.has(lbl) ? "final" : "candidate";
  }
  return "candidate";
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarise(
  rows: readonly Scored[],
  opts: {
    fellBack?: Map<string, number> | Record<string, number>;
    usd?: Map<string, number> | Record<string, number>;
  } = {},
): Summary[] {
  const keys = [...new Set(rows.map((r) => `${r.mode}\0${r.k}`))]
    .map((k) => {
      const [mode, kk] = k.split("\0");
      return [mode!, Number(kk)] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);

  const lookup = (store: Map<string, number> | Record<string, number> | undefined, mode: string, k: number) => {
    if (!store) return 0;
    const key = `${mode}:${k}`;
    if (store instanceof Map) return store.get(key) ?? 0;
    return store[key] ?? 0;
  };

  const out: Summary[] = [];
  for (const [mode, k] of keys) {
    const group = rows.filter((r) => r.mode === mode && r.k === k);
    const good = group.filter((r) => r.graded);
    const units = [
      ...new Set(
        good
          .map((r) => String((r.raw as { metric?: string }).metric || ""))
          .filter(Boolean),
      ),
    ].sort();
    const s = new Summary({
      mode,
      k,
      n: good.length,
      nUngraded: group.length - good.length,
      keptBase: good.filter((r) => r.chosenIsBase).length,
      choseFinal: good.filter((r) => kind(r) === "final").length,
      choseCandidate: good.filter((r) => kind(r) === "candidate").length,
      fellBack: lookup(opts.fellBack, mode, k),
      usd: lookup(opts.usd, mode, k),
      metrics: units,
      score: good.length ? mean(good.map((r) => 100 * (r.frac ?? 0))) : null,
      allPass: good.length
        ? mean(good.map((r) => (r.allPass ? 100 : 0)))
        : null,
    });
    out.push(s);
  }
  return out;
}

export function render(summaries: readonly Summary[], bench = "", title = ""): string {
  const lines: string[] = [];
  if (title) {
    lines.push(title, "=".repeat(Math.max(40, title.length)));
  }
  for (const s of [...summaries].sort((a, b) => a.k - b.k || a.mode.localeCompare(b.mode))) {
    lines.push(s.line(bench));
  }
  const at1 = Object.fromEntries(
    summaries.filter((s) => s.k === 1 && s.score != null).map((s) => [s.mode, s]),
  );
  if (at1.agg && at1.seq && at1.agg.score != null && at1.seq.score != null) {
    const gap = Math.abs(at1.agg.score - at1.seq.score);
    lines.push(
      "",
      "  NOTE  at k=1 the parallel and sequential modes are the same procedure " +
        "(one INVARIANT draw, one DOMAIN draw, one composition).",
      `        The ${gap.toFixed(2)} pt between them is therefore a NOISE FLOOR, not a ` +
        "result -- an effect at k>=2 has to clear it.",
    );
  }
  for (const s of summaries) {
    if (s.n && s.choseFinal <= 0.25 * s.n) {
      lines.push(
        "",
        `  WARNING  ${s.name}: the mode's own final was chosen on only ` +
          `${s.choseFinal}/${s.n} tasks. These records include outputs outside ` +
          `the published pool of ${s.k} composed finals.`,
      );
    }
  }
  for (const s of summaries.filter((x) => x.n && x.keptBase >= 0.8 * x.n)) {
    lines.push(
      "",
      `  WARNING  ${s.name}: selection chose a reference output on ` +
        `${s.keptBase}/${s.n} tasks, outside the published pool of composed outputs.`,
    );
  }
  for (const s of summaries.filter((x) => x.fellBack)) {
    lines.push(
      "",
      `  WARNING  ${s.name}: ${s.fellBack} stage(s) fell back to the ` +
        `inherited harness. Inspect the stage errors when interpreting these results.`,
    );
  }
  for (const s of summaries) {
    if (s.metrics.length > 1) {
      lines.push(
        "",
        `  WARNING  ${s.name}: graded rows carry MIXED scoring units ` +
          `(${s.metrics.join(", ")}); the averaged figure is not comparable across units.`,
      );
    }
  }
  return lines.join("\n");
}

/** (fell_back, usd) keyed `mode:k`, from sweep checkpoint summaries. */
export function spendAndFallbacks(
  nsDir: string,
  modes: readonly string[],
  k: number,
): { fellBack: Record<string, number>; usd: Record<string, number> } {
  const fellBack: Record<string, number> = {};
  const usd: Record<string, number> = {};
  if (!fs.existsSync(nsDir)) return { fellBack, usd };
  for (const name of fs.readdirSync(nsDir).sort()) {
    const summaryPath = path.join(nsDir, name, "summary.json");
    if (!fs.existsSync(summaryPath)) continue;
    let summary: Record<string, unknown>;
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
    } catch (exc) {
      console.log(`  ! skipping unreadable ${summaryPath}: ${exc}`);
      continue;
    }
    const records =
      (summary.modes as Record<string, Record<string, unknown>>) ||
      (summary.arms as Record<string, Record<string, unknown>>) ||
      {};
    const selections = (summary.selections as Record<string, Record<string, unknown>>) || {};
    for (const mode of modes) {
      const key = `${mode}:${k}`;
      const rec = records[mode] || {};
      fellBack[key] = (fellBack[key] ?? 0) + ((rec.fell_back as unknown[]) || []).length;
      const stages = (rec.stages as { usd?: number }[]) || [];
      const spend = stages.reduce((s, st) => s + Number(st.usd || 0), 0);
      const sel = selections[mode] || {};
      usd[key] = (usd[key] ?? 0) + spend + Number(sel.usd || 0);
    }
  }
  return { fellBack, usd };
}
