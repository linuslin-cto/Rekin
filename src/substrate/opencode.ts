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

import * as config from "../config.js";
import type { SurfaceSpec } from "../core/tree.js";

export const OUTPUT_TOKEN_MAX = 32_000;

export const OPENCODE_SURFACE: SurfaceSpec = {
  name: "opencode",
  alwaysOn: [
    "systemprompt.md",
    "guardrails.md",
    "LongTermMEMORY.md",
    "tool_descriptions/tool_guidance.md",
  ],
  alwaysOnMax: 24_000,
  alwaysOnCapReason: "every token here competes with the agent's own output budget",
  skillDir: "skills",
  skillNameRule: "must_match",
  triggerHint:
    'Fix it by adding a trigger line naming `{name}` to systemprompt.md or guardrails.md.',
  autotriggerFile: "guardrails.md",
  triggerLine: "- When {desc}, load the `{name}` skill.\n",
  subagentRequiresMode: true,
  pluginDir: "plugin",
  hooksFile: null,
  stubs: [
    ["scripts/README.md", "<!-- c7: deterministic helpers -->\n"],
    ["sub_agents/README.md", "<!-- c5: delegated subagents -->\n"],
    ["plugin/README.md", "<!-- c8: OpenCode plugins -->\n"],
    ["skills/README.md", "<!-- c6: reusable workflows -->\n"],
  ],
};

export class OpencodeSubstrate {
  name = "oc";

  surface(): SurfaceSpec {
    return OPENCODE_SURFACE;
  }

  runEnv(
    baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
    workspace: string,
    opts: { outputTokenMax?: number; extraAllowed?: readonly string[]; model?: string } = {},
  ): Record<string, string> {
    const allow: Record<string, string> = {
      "*": "deny",
      [workspace]: "allow",
      [`${workspace}/**`]: "allow",
    };
    for (const root of opts.extraAllowed ?? []) {
      allow[root] = "allow";
      allow[`${root}/**`] = "allow";
    }
    const env = config.scrubEnv(baseEnv, {
      keep: config.providerKeys(opts.model || config.SOLVER_MODEL_OC),
    });
    env.OPENCODE_PERMISSION = JSON.stringify({ external_directory: allow });
    env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(
      Math.trunc(opts.outputTokenMax ?? OUTPUT_TOKEN_MAX),
    );
    return env;
  }
}
