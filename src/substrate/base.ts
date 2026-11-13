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

import type { BenchSpec } from "../core/spec.js";
import type { SurfaceSpec } from "../core/tree.js";

export interface Install {
  stagingDir: string;
  fingerprint: string;
  extras?: Record<string, string>;
}

export interface RunRequest {
  taskRef: string;
  runIds: readonly string[];
  timeout: number;
}

export type Launcher = (req: RunRequest, install: Install) => string[];

export interface Substrate {
  name: string;
  surface(): SurfaceSpec;
  materialise(treeDir: string, spec: BenchSpec, ctx: Record<string, string>): Install;
  execute(taskRef: string, install: Install, runIds: string[], timeout: number): string[];
  readTrajectory(
    streamPath: string,
    opts: { obsTrunc: number; maxChars: number; argsTrunc?: number },
  ): string;
  preflight(): void;
}
