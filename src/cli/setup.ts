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

/** Benchmark dependency setup — demo needs no external checkout. */

export function main(argv = process.argv.slice(2)): number {
  let bench = "demo";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bench" && argv[i + 1]) bench = argv[++i]!;
    else if (!argv[i]!.startsWith("-") && bench === "demo") bench = argv[i]!;
  }
  if (bench === "demo") {
    console.log("setup ok: demo adapter needs no third-party checkout");
    return 0;
  }
  console.error(
    `harness2-setup: TypeScript port currently supports only "demo" (got ${JSON.stringify(bench)}). Use the Python package for jb/lab/wb.`,
  );
  return 2;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/setup.ts") || entry.endsWith("/cli/setup.js")) {
  process.exitCode = main();
}
