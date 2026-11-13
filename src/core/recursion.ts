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
import * as config from "../config.js";
import * as context from "./context.js";
import * as prompts from "./prompts.js";
import * as harnessTree from "./tree.js";
import type { Tree } from "./tree.js";
import { Ledger } from "./ledger.js";
import { Proposer, ProposerError, type Reply } from "./proposer.js";
import type { BenchmarkAdapter, RunView } from "./spec.js";
import { resolvePrompts } from "./spec.js";

export const STAGE_ATTEMPTS = 2;
export const TRANSPORT_ATTEMPTS = config.TRANSPORT_ATTEMPTS;
export const PHASE_WIDTH = config.PHASE_WIDTH;

export class Stage {
  label: string;
  dim: string;
  tree: Tree;
  keptBase: boolean;
  fellBack: boolean;
  error: string;
  usd: number;
  attempts: number;
  cached: boolean;
  notes: string;
  executionFailed: boolean;

  constructor(init: {
    label: string;
    dim: string;
    tree: Tree;
    keptBase?: boolean;
    fellBack?: boolean;
    error?: string;
    usd?: number;
    attempts?: number;
    cached?: boolean;
    notes?: string;
    executionFailed?: boolean;
  }) {
    this.label = init.label;
    this.dim = init.dim;
    this.tree = init.tree;
    this.keptBase = init.keptBase ?? false;
    this.fellBack = init.fellBack ?? false;
    this.error = init.error ?? "";
    this.usd = init.usd ?? 0;
    this.attempts = init.attempts ?? 0;
    this.cached = init.cached ?? false;
    this.notes = init.notes ?? "";
    this.executionFailed = init.executionFailed ?? false;
  }
}

export class ModeResult {
  mode: string;
  taskId: string;
  k: number;
  stages: Stage[] = [];
  trees: Record<string, Tree> = {};
  rollouts: Record<string, RunView> = {};
  finals: string[] = [];
  ledger: Ledger | null = null;
  similarity: Record<string, unknown> | null = null;
  errors: string[] = [];

  constructor(mode: string, taskId: string, k: number, ledger: Ledger | null = null) {
    this.mode = mode;
    this.taskId = taskId;
    this.k = k;
    this.ledger = ledger;
  }

  get ok(): boolean {
    return (
      this.finals.length > 0 &&
      this.errors.length === 0 &&
      !this.stages.some((s) => s.executionFailed)
    );
  }

  get fellBack(): string[] {
    return this.stages.filter((s) => s.fellBack).map((s) => s.label);
  }

  toDict(): Record<string, unknown> {
    return {
      mode: this.mode,
      task_id: this.taskId,
      k: this.k,
      finals: this.finals,
      ok: this.ok,
      fell_back: this.fellBack,
      kept_base: this.stages.filter((s) => s.keptBase).map((s) => s.label),
      stages: this.stages.map((s) => ({
        label: s.label,
        dim: s.dim,
        fell_back: s.fellBack,
        kept_base: s.keptBase,
        execution_failed: s.executionFailed,
        attempts: s.attempts,
        usd: s.usd,
        cached: s.cached,
        notes: s.notes,
        error: (s.error || "").slice(0, 400),
      })),
      similarity: this.similarity,
      ledger: this.ledger?.toDict() ?? null,
      errors: this.errors,
    };
  }
}

function acceptTree(
  surface: harnessTree.SurfaceSpec,
  adapter: BenchmarkAdapter,
  neu: Tree,
  fallback: Tree,
  label: string,
): [boolean, string] {
  const triggered = harnessTree.autotrigger(surface, neu);
  if (triggered.length) {
    console.log(`  [${label}] auto-triggered skill(s): ${triggered.join(", ")}`);
  }
  const changed = harnessTree.diffSummary(surface, fallback, neu);
  const kept = !(changed.added.length || changed.removed.length || changed.modified.length);
  try {
    harnessTree.validate(surface, neu, {
      allowSubagents: adapter.spec.allowSubagents,
      reservedScripts: new Set([...harnessTree.RESERVED_SCRIPTS, ...adapter.spec.reservedScripts]),
    });
    adapter.validateTree(neu);
    context.assertTreeHasNoGraderVerdicts(neu);
  } catch (exc) {
    return [kept, exc instanceof Error ? exc.message : String(exc)];
  }
  return [kept, ""];
}

/** Exported for stage-retry regressions (Python `recursion._run_stage`). */
export function runStage(opts: {
  label: string;
  dim: string;
  job: string;
  fallback: Tree;
  adapter: BenchmarkAdapter;
  prop: Proposer;
  ctxDir: string;
  taskId: string;
  rollouts: readonly RunView[];
  harnessDir: string | null;
  libraryDir: string | null;
  pool?: ReadonlyArray<readonly [string, string, RunView | null | undefined]>;
  decisions?: Record<string, string> | null;
}): Stage {
  const surface = opts.adapter.substrate.surface();
  let tree: context.ContextTree;
  try {
    tree = context.build(path.join(opts.ctxDir, opts.label), opts.adapter, opts.taskId, opts.rollouts, {
      harnessDir: opts.harnessDir,
      libraryDir: opts.libraryDir,
      pool: opts.pool ?? [],
      decisions: opts.decisions ?? null,
    });
  } catch (exc) {
    return new Stage({
      label: opts.label,
      dim: opts.dim,
      tree: { ...opts.fallback },
      fellBack: true,
      error: `could not build evidence: ${exc instanceof Error ? exc.message : String(exc)}`.slice(0, 400),
      attempts: 0,
    });
  }

  const mission = context.mission(tree, { job: opts.job });
  let err = "";
  let spentUsd = 0;
  let spentCalls = 0;
  let allCached = true;
  let executionFailed = false;

  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    let reply: Reply;
    try {
      reply = opts.prop.call(
        mission +
          (err
            ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\nFix it in \`context/harness/\` and reply again.`
            : ""),
        tree.root,
        `${opts.label}.a${attempt}`,
        { harvest: "context/harness", maxAttempts: TRANSPORT_ATTEMPTS },
      );
    } catch (exc) {
      if (exc instanceof ProposerError) {
        err = String(exc.message);
        executionFailed = true;
        spentCalls += exc.attempts || TRANSPORT_ATTEMPTS;
        spentUsd += exc.costUsd;
        allCached = false;
        break;
      }
      throw exc;
    }
    spentUsd += reply.costUsd ?? 0;
    spentCalls += reply.cached ? 0 : Math.max(1, reply.attempts ?? 1);
    allCached = allCached && Boolean(reply.cached);

    if (reply.workspace == null) {
      err =
        "the harness directory did not come back from the session; edit the files in `context/harness/` in place";
      continue;
    }
    const rejected: string[] = [];
    const neu = harnessTree.readTree(surface, reply.workspace, { rejected });
    if (!Object.keys(neu).length) {
      err = "`context/harness/` came back empty -- edit the files, do not delete them all";
      continue;
    }
    if (rejected.length) {
      err =
        "these files are off the editable surface and were not applied: " +
        rejected.slice().sort().slice(0, 6).join(", ") +
        `. Component names must be lowercase letters, digits, \`_\` or \`-\` (e.g. \`${surface.skillDir}/doc_review/SKILL.md\`, \`scripts/check_totals.py\`).`;
      harnessTree.writeTree(surface, neu, path.join(tree.root, "harness"));
      continue;
    }

    const [kept, acceptErr] = acceptTree(surface, opts.adapter, neu, opts.fallback, opts.label);
    err = acceptErr;
    if (err) {
      harnessTree.writeTree(surface, neu, path.join(tree.root, "harness"));
      continue;
    }
    const notes = reply.text.match(/<notes>([\s\S]*?)<\/notes>/);
    return new Stage({
      label: opts.label,
      dim: opts.dim,
      tree: neu,
      keptBase: kept,
      usd: spentUsd,
      attempts: spentCalls,
      cached: allCached,
      notes: notes ? notes[1]!.trim() : reply.text.trim(),
    });
  }

  return new Stage({
    label: opts.label,
    dim: opts.dim,
    tree: { ...opts.fallback },
    fellBack: true,
    error: err.slice(0, 400),
    usd: spentUsd,
    attempts: spentCalls,
    cached: allCached,
    executionFailed,
  });
}

function recordSessions(ledger: Ledger, stages: readonly Stage[]): void {
  for (const stage of stages) {
    ledger.session(stage.label, stage.usd, { cached: stage.cached, attempts: stage.attempts });
  }
}

function roll(
  adapter: BenchmarkAdapter,
  ledger: Ledger,
  taskId: string,
  label: string,
  tree: Tree | null,
  runIdOf: (label: string) => string,
  workDir: string,
  opts: { record?: boolean } = {},
): RunView {
  const record = opts.record !== false;
  let hdir: string | null = null;
  if (tree != null) {
    hdir = harnessTree.writeTree(adapter.substrate.surface(), tree, path.join(workDir, "harnesses", label));
  }
  const runId = runIdOf(label);
  let rv: RunView;
  try {
    const rd = adapter.execute(taskId, hdir, runId);
    const exists = fs.existsSync(rd);
    rv = {
      label,
      runId,
      runDir: rd,
      ok: exists,
      delivered: exists && adapter.delivered(rd),
      error: exists ? "" : "adapter returned a missing run directory",
    };
  } catch (exc) {
    rv = {
      label,
      runId,
      runDir: path.join(workDir, "missing"),
      ok: false,
      delivered: false,
      error: `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`,
    };
  }
  if (record) ledger.rollout(label);
  return rv;
}

function rollMany(
  adapter: BenchmarkAdapter,
  ledger: Ledger,
  taskId: string,
  items: ReadonlyArray<readonly [string, Tree]>,
  runIdOf: (label: string) => string,
  workDir: string,
  opts: { width: number },
): Record<string, RunView> {
  const out: Record<string, RunView> = {};
  if (!items.length) return out;
  // Sequential for deterministic ledger order (DemoProposer is sync; parallel later).
  void opts.width;
  for (const [label, tree] of items) {
    out[label] = roll(adapter, ledger, taskId, label, tree, runIdOf, workDir, { record: true });
  }
  return out;
}

export function runParallel(
  taskId: string,
  k: number,
  base: readonly RunView[],
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    workDir: string;
    runIdOf: (label: string) => string;
    baseTree: Tree;
    libraryDir?: string | null;
    proposeWorkers?: number;
    rolloutWorkers?: number;
  },
): ModeResult {
  const surface = opts.adapter.substrate.surface();
  const ledger = new Ledger("agg", taskId, k);
  for (const r of base) ledger.rollout(r.label);
  const result = new ModeResult("agg", taskId, k, ledger);
  for (const r of base) result.rollouts[r.label] = r;
  const ctxDir = path.join(opts.workDir, "context");
  const benchmarkPrompts = resolvePrompts(opts.adapter, taskId);
  const baseDir = harnessTree.writeTree(surface, opts.baseTree, path.join(opts.workDir, "harnesses", "base"));

  const specs: Array<[string, string, number]> = [];
  for (let i = 1; i <= k; i++) {
    for (const d of ["INV", "DOM"] as const) specs.push([`${d.toLowerCase()}${i}`, d, i]);
  }
  const stages = specs.map(([label, dim, index]) =>
    runStage({
      label,
      dim,
      job: prompts.propose(benchmarkPrompts, dim, surface, { k, index }),
      fallback: opts.baseTree,
      adapter: opts.adapter,
      prop: opts.prop,
      ctxDir,
      taskId,
      rollouts: base,
      harnessDir: baseDir,
      libraryDir: opts.libraryDir ?? null,
    }),
  );
  recordSessions(ledger, stages);
  for (const stage of stages) {
    result.stages.push(stage);
    result.trees[stage.label] = stage.tree;
  }
  Object.assign(
    result.rollouts,
    rollMany(
      opts.adapter,
      ledger,
      taskId,
      stages.map((s) => [s.label, s.tree] as const),
      opts.runIdOf,
      opts.workDir,
      { width: opts.rolloutWorkers ?? PHASE_WIDTH },
    ),
  );

  const poolEv = stages.map(
    (stage) =>
      [
        stage.label,
        path.join(opts.workDir, "harnesses", stage.label),
        result.rollouts[stage.label] ?? null,
      ] as const,
  );
  const aggSpecs = Array.from({ length: k }, (_, i) => `agg${i + 1}`);
  const aggs = aggSpecs.map((lbl) =>
    runStage({
      label: lbl,
      dim: "AGG",
      job: prompts.aggregate(benchmarkPrompts, surface, { k, index: Number(lbl.slice(3)) }),
      fallback: opts.baseTree,
      adapter: opts.adapter,
      prop: opts.prop,
      ctxDir,
      taskId,
      rollouts: base,
      harnessDir: baseDir,
      libraryDir: opts.libraryDir ?? null,
      pool: poolEv,
      decisions: Object.fromEntries(stages.map((s) => [s.label, s.notes || s.error])),
    }),
  );
  recordSessions(ledger, aggs);
  for (const stage of aggs) {
    result.stages.push(stage);
    result.trees[stage.label] = stage.tree;
    result.finals.push(stage.label);
  }
  Object.assign(
    result.rollouts,
    rollMany(
      opts.adapter,
      ledger,
      taskId,
      aggs.map((s) => [s.label, s.tree] as const),
      opts.runIdOf,
      opts.workDir,
      { width: opts.rolloutWorkers ?? PHASE_WIDTH },
    ),
  );

  result.similarity = harnessTree.diversity(
    Object.fromEntries(aggs.map((s) => [s.label, s.tree])),
  );
  ledger.assertIdentity();
  return result;
}

export function runSequential(
  taskId: string,
  k: number,
  base: readonly RunView[],
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    workDir: string;
    runIdOf: (label: string) => string;
    baseTree: Tree;
    libraryDir?: string | null;
    proposeWorkers?: number;
    rolloutWorkers?: number;
  },
): ModeResult {
  const surface = opts.adapter.substrate.surface();
  const ledger = new Ledger("seq", taskId, k);
  for (const r of base) ledger.rollout(r.label);
  const result = new ModeResult("seq", taskId, k, ledger);
  for (const r of base) result.rollouts[r.label] = r;
  const ctxDir = path.join(opts.workDir, "context");
  const benchmarkPrompts = resolvePrompts(opts.adapter, taskId);

  let currentHarness: Tree = { ...opts.baseTree };
  let history: Array<readonly [string, string, RunView | null | undefined]> = [];

  for (let t = 1; t <= k; t++) {
    const currentLabel = t > 1 ? `c${t - 1}` : "base";
    const currentDir = harnessTree.writeTree(
      surface,
      currentHarness,
      path.join(opts.workDir, "harnesses", currentLabel),
    );
    const specs: Array<[string, string]> = [
      [`inv${t}`, "INV"],
      [`dom${t}`, "DOM"],
    ];
    const stages = specs.map(([label, dim]) =>
      runStage({
        label,
        dim,
        job: prompts.propose(benchmarkPrompts, dim, surface, {
          k,
          index: t,
          roundT: k > 1 ? t : null,
        }),
        fallback: currentHarness,
        adapter: opts.adapter,
        prop: opts.prop,
        ctxDir,
        taskId,
        rollouts: base,
        harnessDir: currentDir,
        libraryDir: opts.libraryDir ?? null,
        pool: history,
        decisions: Object.fromEntries(result.stages.map((s) => [s.label, s.notes || s.error])),
      }),
    );
    recordSessions(ledger, stages);
    for (const stage of stages) {
      result.stages.push(stage);
      result.trees[stage.label] = stage.tree;
    }
    Object.assign(
      result.rollouts,
      rollMany(
        opts.adapter,
        ledger,
        taskId,
        stages.map((s) => [s.label, s.tree] as const),
        opts.runIdOf,
        opts.workDir,
        { width: opts.rolloutWorkers ?? PHASE_WIDTH },
      ),
    );

    const roundPool: Array<readonly [string, string, RunView | null | undefined]> = [
      ...history,
      ...stages.map(
        (stage) =>
          [
            stage.label,
            path.join(opts.workDir, "harnesses", stage.label),
            result.rollouts[stage.label] ?? null,
          ] as const,
      ),
    ];
    const ck = `c${t}`;
    const compJob =
      k === 1
        ? prompts.aggregate(benchmarkPrompts, surface, { k: 1, index: 1 })
        : prompts.composeRound(benchmarkPrompts, surface, { t, k });
    const comp = runStage({
      label: ck,
      dim: "COMPOSE",
      job: compJob,
      fallback: currentHarness,
      adapter: opts.adapter,
      prop: opts.prop,
      ctxDir,
      taskId,
      rollouts: base,
      harnessDir: currentDir,
      libraryDir: opts.libraryDir ?? null,
      pool: roundPool,
      decisions: Object.fromEntries(result.stages.map((s) => [s.label, s.notes || s.error])),
    });
    recordSessions(ledger, [comp]);
    result.stages.push(comp);
    result.trees[ck] = comp.tree;
    result.rollouts[ck] = roll(
      opts.adapter,
      ledger,
      taskId,
      ck,
      comp.tree,
      opts.runIdOf,
      opts.workDir,
    );
    history = [
      ...roundPool,
      [ck, path.join(opts.workDir, "harnesses", ck), result.rollouts[ck]] as const,
    ];
    currentHarness = comp.tree;
  }

  result.finals = Array.from({ length: k }, (_, i) => `c${i + 1}`);
  ledger.assertIdentity();
  return result;
}

export function runMode(
  mode: string,
  taskId: string,
  k: number,
  base: readonly RunView[],
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    workDir: string;
    runIdOf: (label: string) => string;
    baseTree: Tree;
    libraryDir?: string | null;
  },
): ModeResult {
  if (mode === "agg") return runParallel(taskId, k, base, opts);
  if (mode === "seq") return runSequential(taskId, k, base, opts);
  throw new Error(
    `unknown mode ${JSON.stringify(mode)}; the method has exactly two: 'agg' (parallel) and 'seq' (sequential)`,
  );
}
