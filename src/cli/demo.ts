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

/** Run the real recursion and library workflow with local, deterministic editors. */

import fs from "node:fs";
import path from "node:path";
import { modeToken, runDomain } from "../core/schedule.js";
import { DemoAdapter, DemoProposer } from "../demo.js";

export function main(argv = process.argv.slice(2)): number {
  let output = "runs/demo";
  let k = 2;
  let mode: "parallel" | "sequential" | "both" = "both";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" && argv[i + 1]) output = argv[++i]!;
    else if (argv[i] === "--k" && argv[i + 1]) k = Number(argv[++i]);
    else if (argv[i] === "--mode" && argv[i + 1]) {
      const m = argv[++i]!;
      if (m !== "parallel" && m !== "sequential" && m !== "both") {
        throw new Error(`--mode must be parallel|sequential|both, got ${m}`);
      }
      mode = m;
    }
  }
  if (!(k >= 1)) throw new Error("--k must be positive");

  const root = path.resolve(output);
  const adapter = new DemoAdapter(root);
  const proposer = new DemoProposer(adapter.spec.channels.proposer!);
  const modes = mode === "both" ? (["agg", "seq"] as const) : ([modeToken(mode)] as const);
  const result = runDomain("accounting", adapter.tasks(), k, {
    adapter,
    prop: proposer,
    runsRoot: adapter.spec.runsRoot,
    libraryRoot: path.join(root, "library", `k${k}`),
    modes,
  }) as Record<string, unknown>;
  result.execution_count = adapter.executionCount;
  result.editor_calls = proposer.calls.length;
  const report = path.join(root, "demo.json");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(
    `Local demo: ${result.done} tasks completed; ${result.failed} failed. ${report}`,
  );
  return Number(result.failed) > 0 ? 1 : 0;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/demo.ts") || entry.endsWith("/cli/demo.js") || entry.endsWith("demo.ts")) {
  process.exitCode = main();
}
