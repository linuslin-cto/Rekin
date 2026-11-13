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
import { modeToken, runSweep } from "../core/schedule.js";
import { DemoAdapter, DemoProposer } from "../demo.js";

export function main(argv = process.argv.slice(2)): number {
  let output = "runs/demo";
  let k = 1;
  let mode: "parallel" | "sequential" | "both" = "both";
  let maxTasks: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" && argv[i + 1]) output = argv[++i]!;
    else if (argv[i] === "--k" && argv[i + 1]) k = Number(argv[++i]);
    else if (argv[i] === "--mode" && argv[i + 1]) {
      const m = argv[++i]!;
      if (m !== "parallel" && m !== "sequential" && m !== "both") {
        throw new Error(`--mode must be parallel|sequential|both, got ${m}`);
      }
      mode = m;
    } else if (argv[i] === "--max-tasks" && argv[i + 1]) maxTasks = Number(argv[++i]);
  }
  if (!(k >= 1)) throw new Error("--k must be positive");
  const root = path.resolve(output);
  const adapter = new DemoAdapter(root);
  const proposer = new DemoProposer(adapter.spec.channels.proposer!);
  const modes = mode === "both" ? (["agg", "seq"] as const) : ([modeToken(mode)] as const);
  const result = runSweep(k, {
    adapter,
    prop: proposer,
    runsRoot: adapter.spec.runsRoot,
    libraryRoot: path.join(root, "library", `k${k}`),
    modes,
    maxTasks,
  });
  const report = path.join(root, "sweep.json");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n", "utf8");
  const failed = (result.domains as { failed?: number }[]).reduce(
    (s, d) => s + Number(d.failed ?? 0),
    0,
  );
  console.log(
    `Sweep: ${result.n_domains} domain(s), failed tasks=${failed}. ${report}`,
  );
  return failed > 0 ? 1 : 0;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/run-sweep.ts") || entry.endsWith("/cli/run-sweep.js")) {
  process.exitCode = main();
}
