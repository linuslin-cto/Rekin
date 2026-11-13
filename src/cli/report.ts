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

import path from "node:path";
import { loadRows } from "../core/judge.js";
import { render, spendAndFallbacks, summarise } from "../core/report.js";
import { MODE_NAMES, modeToken, MODES, ns } from "../core/schedule.js";
import { DemoAdapter } from "../demo.js";

export function main(argv = process.argv.slice(2)): number {
  let output = "";
  let bench = "demo";
  let kArg = "1";
  let seed: number | null = null;
  let modes: string[] = [...MODES];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--output" && argv[i + 1]) output = argv[++i]!;
    else if (a === "--bench" && argv[i + 1]) bench = argv[++i]!;
    else if (a === "--k" && argv[i + 1]) kArg = argv[++i]!;
    else if (a === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
    else if (a === "--modes" && argv[i + 1]) {
      modes = argv[++i]!.split(",").map((m) => modeToken(m.trim()));
    } else if (a === "--mode" && argv[i + 1]) {
      modes = [modeToken(argv[++i]!)];
    }
  }
  if (bench !== "demo") {
    console.error(`rekin-report: only --bench demo is available so far (got ${bench})`);
    return 2;
  }
  let ks: number[];
  try {
    ks = [...new Set(kArg.split(",").map((s) => s.trim()).filter(Boolean).map((s) => Number.parseInt(s, 10)))].sort(
      (a, b) => a - b,
    );
    if (ks.some((k) => !Number.isFinite(k))) throw new Error("nan");
  } catch {
    console.error(`--k takes a comma list of ints, got ${JSON.stringify(kArg)}`);
    return 2;
  }
  if (!ks.length) {
    console.error("--k named no scale");
    return 2;
  }

  const root = path.resolve(output || "runs/demo");
  const adapter = new DemoAdapter(root);
  const rows = [];
  const fellBack: Record<string, number> = {};
  const usd: Record<string, number> = {};
  for (const k of ks) {
    const cell = ns("demo", "oc", "agg", k, { seed });
    const nsDir = path.join(adapter.spec.runsRoot, cell);
    const judged = path.join(nsDir, "judged.json");
    const got = loadRows(judged);
    if (!got.length) {
      console.log(`  ! no judged rows at ${judged} — run rekin-judge for k=${k} first`);
      continue;
    }
    rows.push(...got.filter((r) => modes.includes(r.mode)));
    const spend = spendAndFallbacks(nsDir, modes, k);
    Object.assign(fellBack, spend.fellBack);
    Object.assign(usd, spend.usd);
  }
  if (!rows.length) {
    console.error("nothing to report");
    return 2;
  }

  const title =
    `${adapter.spec.name}-oc` +
    (seed != null ? ` seed=${seed}` : "") +
    ` modes=${modes.map((m) => MODE_NAMES[m as keyof typeof MODE_NAMES] ?? m).join(",")}`;
  const summaries = summarise(rows, { fellBack, usd });
  console.log(render(summaries, adapter.spec.name, title));
  const spendTotal = summaries.reduce((s, x) => s + x.usd, 0);
  if (spendTotal) {
    console.log(
      `\n  improver (editors, composer, selection, reflection) spend across reported modes: $${spendTotal.toFixed(2)}`,
    );
  }
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/report.ts") || entry.endsWith("/cli/report.js")) {
  process.exitCode = main();
}
