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

import os from "node:os";
import path from "node:path";
import { check } from "../preflight.js";
import { DemoAdapter } from "../demo.js";

export function main(argv = process.argv.slice(2)): number {
  let bench = "demo";
  let judge = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bench" && argv[i + 1]) bench = argv[++i]!;
    else if (argv[i] === "--judge") judge = true;
  }
  if (bench !== "demo") {
    console.error(
      `rekin-check: only --bench demo is available in the TypeScript port so far (got ${bench})`,
    );
    return 2;
  }
  const root = path.join(os.tmpdir(), `harness2-check-${process.pid}`);
  const adapter = new DemoAdapter(root);
  const errors = check(adapter, { judge });
  if (!errors.length) {
    console.log("preflight ok (demo)");
    return 0;
  }
  for (const e of errors) console.error(e);
  return 1;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/check.ts") || entry.endsWith("/cli/check.js")) {
  process.exitCode = main();
}
