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
import * as config from "../config.js";
import type { SurfaceSpec } from "../core/tree.js";

export const CODEX_SURFACE: SurfaceSpec = {
  name: "codex",
  alwaysOn: ["AGENTS.md"],
  alwaysOnMax: 8_000,
  alwaysOnCapReason:
    "AGENTS.md is injected whole into EVERY turn, and codex additionally truncates it silently at 32,768 bytes",
  skillDir: ".agents/skills",
  skillNameRule: "overrides_dir",
  triggerHint:
    'Fix it by adding a trigger line naming `{name}` to AGENTS.md, e.g. "When <the situation this skill handles>, read .agents/skills/{name}/SKILL.md and follow it."',
  autotriggerFile: "AGENTS.md",
  triggerLine: "- When {desc}, read .agents/skills/{name}/SKILL.md and follow it.\n",
  subagentRequiresMode: false,
  pluginDir: null,
  hooksFile: ".codex/hooks.json",
  hookEvents: new Set([
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
    "Stop",
  ]),
  compileSkillScripts: true,
  rejectEmptyAlwaysOn: true,
  stubs: [
    [
      "scripts/README.md",
      "<!-- c7: deterministic helpers, run as `python3 scripts/<name>.py`. Add one by emitting scripts/<name>.py. -->\n",
    ],
    [
      "sub_agents/README.md",
      "<!-- c5: delegated codex agent roles, each spawned in its OWN context. Add one as sub_agents/<name>/AGENT.md with frontmatter `description:`; the runner installs it as a [agents.<name>] role. -->\n",
    ],
    [
      ".codex/README.md",
      "<!-- c8: codex lifecycle hooks -- the only lever that acts INSIDE the tool loop, so the model cannot skip it. Add ONE file, .codex/hooks.json. -->\n",
    ],
  ],
};

export class CodexSubstrate {
  name = "cx";

  surface(): SurfaceSpec {
    return CODEX_SURFACE;
  }

  execEnv(
    baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
    opts: { codexHome: string },
  ): Record<string, string> {
    const env = config.scrubEnv(baseEnv);
    delete env.OPENAI_BASE_URL;
    env.CODEX_HOME = opts.codexHome;
    const distPath = path.join(config.DEPENDENCIES, "codex-dist", "codex-path");
    env.PATH = `${distPath}${path.delimiter}${env.PATH ?? ""}`;
    return env;
  }
}
