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

import fs from "node:fs";
import path from "node:path";
import {
  collectSelections,
  judgeSelections,
  loadRows,
  mergeRows,
  write,
} from "../core/judge.js";
import { modeToken, MODES, ns } from "../core/schedule.js";
import { DemoAdapter } from "../demo.js";

export function main(argv = process.argv.slice(2)): number {
  let output = "";
  let bench = "demo";
  let k = 2;
  let seed: number | null = null;
  let modes: string[] = [...MODES];
  let bases = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--output" && argv[i + 1]) output = argv[++i]!;
    else if (a === "--bench" && argv[i + 1]) bench = argv[++i]!;
    else if (a === "--k" && argv[i + 1]) k = Number(argv[++i]);
    else if (a === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
    else if (a === "--modes" && argv[i + 1]) {
      modes = argv[++i]!.split(",").map((m) => modeToken(m.trim()));
    } else if (a === "--mode" && argv[i + 1]) {
      modes = [modeToken(argv[++i]!)];
    } else if (a === "--bases") bases = true;
  }
  if (bench !== "demo") {
    console.error(`rekin-judge: only --bench demo is available so far (got ${bench})`);
    return 2;
  }
  const root = path.resolve(output || "runs/demo");
  const adapter = new DemoAdapter(root);
  // Demo summaries live under the parallel (agg) namespace cell, matching run-sweep/demo.
  const cell = ns("demo", "oc", "agg", k, { seed });
  const nsDir = path.join(adapter.spec.runsRoot, cell);
  if (!fs.existsSync(nsDir)) {
    console.error(`nothing to judge: ${nsDir} does not exist — run rekin-demo first`);
    return 2;
  }
  if (bases) {
    return judgeBases(adapter, nsDir);
  }

  const sels = collectSelections(nsDir, modes);
  if (!sels.length) {
    console.error(
      `nothing to judge: no selections for modes ${modes.join(",")} under ${nsDir}`,
    );
    return 2;
  }
  console.log(`judging ${sels.length} selection(s) under ${cell} ...`);
  const rows = judgeSelections(adapter, sels);
  const outPath = path.join(nsDir, "judged.json");
  const merged = mergeRows(loadRows(outPath), rows);
  write(merged, outPath);
  const graded = merged.filter((r) => r.graded).length;
  console.log(
    `judged.json: ${merged.length} row(s), ${graded} graded, ${merged.length - graded} ungraded`,
  );
  console.log(`wrote ${outPath}`);
  return rows.length && rows.every((r) => r.graded) ? 0 : 2;
}

function judgeBases(adapter: DemoAdapter, nsDir: string): number {
  const rows: Record<string, unknown>[] = [];
  let legacy = 0;
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
    const taskId = String(summary.task_id ?? "");
    for (const entry of (summary.base as Record<string, unknown>[]) || []) {
      if (!entry || typeof entry !== "object" || !entry.run_dir) {
        legacy += 1;
        continue;
      }
      const label = String(entry.label ?? "");
      const runDir = String(entry.run_dir);
      let got: Record<string, unknown> | null = null;
      try {
        got = fs.existsSync(runDir) && fs.statSync(runDir).isDirectory()
          ? adapter.score(runDir, taskId)
          : null;
      } catch (exc) {
        console.log(`  ${taskId.slice(0, 52).padEnd(52)} ${label} ERROR ${exc}`);
        got = null;
      }
      const shown = got == null ? "-" : `${got.n_passed}/${got.n_criteria}`;
      console.log(`  ${taskId.slice(0, 52).padEnd(52)} ${label} ${shown}`);
      rows.push({
        task: taskId,
        label,
        run_id: entry.run_id ?? "",
        score: got,
      });
    }
  }
  if (legacy) {
    console.log(
      `  ${legacy} reference execution(s) predate run-directory recording and cannot be scored`,
    );
  }
  if (!rows.length) {
    console.log(`no reference executions recorded under ${nsDir}; wrote nothing`);
    return 2;
  }
  const out = path.join(nsDir, "base_judged.json");
  fs.writeFileSync(out, JSON.stringify(rows, null, 1), "utf8");
  const graded = rows.filter((r) => r.score != null).length;
  console.log(`wrote ${out}: ${rows.length} row(s), ${graded} graded`);
  return graded === rows.length ? 0 : 2;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/judge.ts") || entry.endsWith("/cli/judge.js")) {
  process.exitCode = main();
}
