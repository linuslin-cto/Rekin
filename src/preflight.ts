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

/** Benchmark dependency and runtime readiness checks (demo-safe subset). */

import type { BenchmarkAdapter } from "./core/spec.js";
import * as config from "./config.js";

export function check(adapter: BenchmarkAdapter, opts: { judge?: boolean } = {}): string[] {
  const errors: string[] = [];
  try {
    if (opts.judge) config.validateModels({ judge: true });
  } catch (exc) {
    // Demo / local adapters often have empty model ids; only surface when judge is requested.
    if (opts.judge) errors.push(exc instanceof Error ? exc.message : String(exc));
  }
  try {
    adapter.tasks();
  } catch (exc) {
    errors.push(exc instanceof Error ? exc.message : String(exc));
  }
  const preflight = (adapter as { preflight?: () => void }).preflight;
  if (typeof preflight === "function") {
    try {
      preflight.call(adapter);
    } catch (exc) {
      errors.push(exc instanceof Error ? exc.message : String(exc));
    }
  }
  return errors;
}

export function requireReady(adapter: BenchmarkAdapter, opts: { judge?: boolean } = {}): void {
  const errors = check(adapter, opts);
  if (errors.length) {
    throw new Error(`preflight failed:\n- ${errors.join("\n- ")}`);
  }
}
