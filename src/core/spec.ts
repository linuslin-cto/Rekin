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

/** The benchmark seam: everything a benchmark must supply, and nothing more. */

import * as config from "../config.js";
import type { SurfaceSpec, Tree } from "./tree.js";

export type ModelId = string;

export const CHANNELS = ["claude_cli", "opencode"] as const;
export type ChannelKind = (typeof CHANNELS)[number];

export interface ChannelSpec {
  kind: string;
  model: ModelId;
  effort?: string;
  steps?: number;
  timeout?: number;
}

export function makeChannelSpec(
  kind: string,
  model: ModelId,
  opts: { effort?: string; steps?: number; timeout?: number } = {},
): ChannelSpec {
  if (!(CHANNELS as readonly string[]).includes(kind)) {
    throw new Error(`unknown channel ${JSON.stringify(kind)}; expected one of ${CHANNELS}`);
  }
  return {
    kind,
    model,
    effort: opts.effort ?? "high",
    steps: opts.steps ?? 120,
    timeout: opts.timeout ?? 3600,
  };
}

export function resolveChannelModel(
  kind: string | null | undefined,
  model: string | null | undefined,
  opts: { effort?: string; steps?: number; timeout?: number } = {},
): ChannelSpec {
  const useDefault = kind == null && model == null;
  if ((kind == null) !== (model == null)) {
    throw new Error(
      `channel and model must be overridden TOGETHER (a bare-id/provider-prefixed mismatch fails silently downstream); got kind=${JSON.stringify(kind)}, model=${JSON.stringify(model)}`,
    );
  }
  kind ??= config.DEFAULT_PROPOSER_CHANNEL;
  if (!(CHANNELS as readonly string[]).includes(kind)) {
    throw new Error(`unknown channel ${JSON.stringify(kind)}; expected one of ${CHANNELS}`);
  }
  model ??= config.PROPOSER_MODEL_BY_CHANNEL[kind] ?? "";
  if (!model.trim()) {
    if (useDefault) {
      return makeChannelSpec(kind, "", opts);
    }
    throw new Error("model override must not be empty");
  }
  if (kind === "opencode" && !model.includes("/")) {
    throw new Error(
      `opencode channel needs a provider-prefixed model id in HARNESS2_IMPROVER_MODEL or HARNESS2_SOLVER_MODEL, got ${JSON.stringify(model)}`,
    );
  }
  if (kind === "claude_cli" && model.includes("/")) {
    throw new Error(
      `claude_cli channel takes a bare Anthropic id (e.g. ${JSON.stringify(config.PROPOSER_MODEL_BY_CHANNEL.claude_cli)}), got ${JSON.stringify(model)}`,
    );
  }
  return makeChannelSpec(kind, model, opts);
}

export interface BenchPrompts {
  work: string;
  domainWord?: string;
  invLevers?: string;
  domLevers?: string;
  yardstick?: string;
  deliverableWord?: string;
  domainGuidance?: string;
  selectionChecks?: string;
  selectionLead?: string;
  selectionConformance?: string;
  promptPack?: "adapt" | "tts";
}

export function makeBenchPrompts(init: BenchPrompts): Required<BenchPrompts> {
  const prompts: Required<BenchPrompts> = {
    work: init.work,
    domainWord: init.domainWord ?? "domain",
    invLevers: init.invLevers ?? "",
    domLevers: init.domLevers ?? "",
    yardstick: init.yardstick ?? "",
    deliverableWord: init.deliverableWord ?? "deliverable",
    domainGuidance: init.domainGuidance ?? "",
    selectionChecks: init.selectionChecks ?? "",
    selectionLead: init.selectionLead ?? "",
    selectionConformance: init.selectionConformance ?? "full",
    promptPack: init.promptPack ?? "adapt",
  };
  if (prompts.promptPack !== "adapt" && prompts.promptPack !== "tts") {
    throw new Error(`BenchPrompts.promptPack must be 'adapt' or 'tts', got ${JSON.stringify(prompts.promptPack)}`);
  }
  const visible: Record<string, string> = {
    work: prompts.work,
    inv_levers: prompts.invLevers,
    dom_levers: prompts.domLevers,
    yardstick: prompts.yardstick,
    domain_guidance: prompts.domainGuidance,
    selection_checks: prompts.selectionChecks,
  };
  for (const [fieldName, value] of Object.entries(visible)) {
    const low = value.toLowerCase();
    for (const bad of ["benchmark", "evaluation", "grader", "rubric", "score"]) {
      if (low.includes(bad)) {
        throw new Error(
          `BenchPrompts.${fieldName} must describe the WORK, not its measurement (found ${JSON.stringify(bad)}). Say what the practitioner needs.`,
        );
      }
    }
  }
  return prompts;
}

export const INSTALL_MODES = [
  "workspace_agents_md",
  "home_dir_jinja",
  "workspace_config",
  "codex_root",
] as const;

export interface BenchSpec {
  name: string;
  runsRoot: string;
  installMode: string;
  prompts: Required<BenchPrompts>;
  channels: Record<string, ChannelSpec>;
  domainWord?: string;
  leakGlobs?: readonly string[];
  allowSubagents?: boolean;
  reservedScripts?: ReadonlySet<string>;
  proposerDeliverables?: "contents" | "names";
  stateDeliverable?: boolean;
  obsTrunc?: number;
}

export function makeBenchSpec(init: BenchSpec): Required<
  Pick<
    BenchSpec,
    | "name"
    | "runsRoot"
    | "installMode"
    | "prompts"
    | "channels"
    | "domainWord"
    | "leakGlobs"
    | "allowSubagents"
    | "reservedScripts"
    | "proposerDeliverables"
    | "stateDeliverable"
    | "obsTrunc"
  >
> {
  if (!(INSTALL_MODES as readonly string[]).includes(init.installMode)) {
    throw new Error(
      `unknown install_mode ${JSON.stringify(init.installMode)}; expected one of ${INSTALL_MODES}`,
    );
  }
  const proposerDeliverables = init.proposerDeliverables ?? "contents";
  if (proposerDeliverables !== "contents" && proposerDeliverables !== "names") {
    throw new Error(
      `BenchSpec.proposerDeliverables must be 'contents' or 'names', got ${JSON.stringify(proposerDeliverables)}`,
    );
  }
  for (const role of ["proposer", "selector"] as const) {
    if (!(role in init.channels)) {
      throw new Error(`BenchSpec.channels must define ${JSON.stringify(role)}`);
    }
  }
  const obsTrunc = init.obsTrunc ?? 50_000;
  if (obsTrunc < 10_000) {
    throw new Error(
      `obs_trunc=${obsTrunc} is in the range that fabricates defects; use >= 10_000 (default 50_000)`,
    );
  }
  const reservedScripts = new Set(init.reservedScripts ?? []);
  const bad = [...reservedScripts].filter((s) => s.includes("/") || !s.endsWith(".py")).sort();
  if (bad.length) {
    throw new Error(`BenchSpec.reserved_scripts takes bare .py BASENAMES, not paths: ${bad}`);
  }
  return {
    name: init.name,
    runsRoot: init.runsRoot,
    installMode: init.installMode,
    prompts: init.prompts,
    channels: init.channels,
    domainWord: init.domainWord ?? "domain",
    leakGlobs: init.leakGlobs ?? [],
    allowSubagents: init.allowSubagents ?? false,
    reservedScripts,
    proposerDeliverables,
    stateDeliverable: init.stateDeliverable ?? false,
    obsTrunc,
  };
}

export interface RunView {
  label: string;
  runId: string;
  runDir: string;
  ok: boolean;
  delivered: boolean;
  costUsd?: number;
  wallS?: number;
  error?: string;
}

export interface SubstrateLike {
  name: string;
  surface(): SurfaceSpec;
}

export interface BenchmarkAdapter {
  spec: ReturnType<typeof makeBenchSpec>;
  substrate: SubstrateLike;
  tasks(split?: string): string[];
  domainOf(taskId: string): string;
  taskPrompt(taskId: string): string;
  taskFiles(taskId: string): string | null;
  execute(
    taskId: string,
    harnessDir: string | null,
    runId: string,
    opts?: { timeout?: number | null },
  ): string;
  delivered(runDir: string): boolean;
  trajectory(runDir: string, opts: { obsTrunc: number }): string;
  deliverableFiles(runDir: string): Record<string, string>;
  deliverableText(runDir: string): string;
  baseHarness(): string;
  validateTree(tree: Tree): void;
  score(runDir: string, taskId: string): Record<string, unknown> | null;
  promptsFor?(taskId: string): Required<BenchPrompts>;
}

export function resolvePrompts(
  adapter: BenchmarkAdapter,
  taskId: string,
): Required<BenchPrompts> {
  if (typeof adapter.promptsFor === "function") {
    return adapter.promptsFor(taskId);
  }
  return adapter.spec.prompts;
}
