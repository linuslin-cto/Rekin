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
import * as libraryStore from "./library.js";
import * as recursion from "./recursion.js";
import * as runmark from "./runmark.js";
import * as selection from "./selection.js";
import * as harnessTree from "./tree.js";
import type { Tree } from "./tree.js";
import { Proposer } from "./proposer.js";
import type { BenchmarkAdapter, RunView } from "./spec.js";

export const MODES = ["agg", "seq"] as const;
export const MODE_NAMES = { agg: "parallel", seq: "sequential" } as const;
const MODE_ALIASES: Record<string, "agg" | "seq"> = {
  agg: "agg",
  seq: "seq",
  parallel: "agg",
  sequential: "seq",
};

export function modeToken(name: string): "agg" | "seq" {
  const key = String(name || "").trim().toLowerCase();
  if (!(key in MODE_ALIASES)) {
    throw new Error(
      `unknown mode ${JSON.stringify(name)}; expected parallel | sequential (or the on-disk tokens ${MODES})`,
    );
  }
  return MODE_ALIASES[key]!;
}

export function validateTag(tag: string): void {
  if (!tag) return;
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.\-]*$/.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} must be [A-Za-z0-9_.-] with no leading '-' and no '/': it becomes a path segment and a run-id segment`,
    );
  }
  if (/^s\d+(-|$)/.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} spells a seed segment; pass --seed instead so seeded and tagged namespaces can never collide`,
    );
  }
}

export function ns(
  benchmark: string,
  substrate: string,
  mode: string,
  k: number,
  opts: { seed?: number | null; tag?: string } = {},
): string {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown mode ${JSON.stringify(mode)}; the method has exactly two: ${MODES}`);
  }
  if (!substrate) {
    throw new Error(
      "namespace needs a substrate name ('oc' | 'cx'); an empty one would let the two substrates' caches collide on every label",
    );
  }
  validateTag(opts.tag ?? "");
  let out = `${benchmark}-${substrate}-${mode}${Math.trunc(k)}`;
  if (opts.seed != null) out += `-s${Math.trunc(opts.seed)}`;
  if (opts.tag) out += `-${opts.tag}`;
  return out;
}

function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle<T>(items: T[], seedText: string): T[] {
  const out = [...items];
  let s = hashSeed(seedText);
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Continual-learning stream order. seed=null uses referenceDomainOrder; int seed shuffles. */
export function streamOrder(
  tasksByDomain: Record<string, readonly string[]>,
  seed: number | null,
  referenceDomainOrder: readonly string[],
): Array<[string, string]> {
  const domains = Object.keys(tasksByDomain).sort();
  let orderedDomains: string[];
  if (seed == null) {
    const missing = domains.filter((d) => !referenceDomainOrder.includes(d));
    if (missing.length) {
      throw new Error(
        `reference_domain_order does not cover domain(s) ${missing}; the frozen order list is stale — regenerate it rather than letting an unlisted domain land in an arbitrary position`,
      );
    }
    orderedDomains = referenceDomainOrder.filter((d) => d in tasksByDomain);
  } else {
    orderedDomains = seededShuffle(domains, `${seed}:__domains__`);
  }
  const out: Array<[string, string]> = [];
  for (const d of orderedDomains) {
    let tasks = [...tasksByDomain[d]!].sort();
    if (seed != null) tasks = seededShuffle(tasks, `${seed}:${d}`);
    for (const t of tasks) out.push([d, t]);
  }
  return out;
}

export function defaultReferenceDomainOrder(
  byDomain: Record<string, readonly string[]>,
): string[] {
  return Object.keys(byDomain).sort(
    (a, b) => byDomain[b]!.length - byDomain[a]!.length || a.localeCompare(b),
  );
}

export class Namespace {
  benchmark: string;
  substrate: string;
  mode: string;
  k: number;
  seed: number | null;
  tag: string;

  constructor(
    benchmark: string,
    substrate: string,
    mode: string,
    k: number,
    seed: number | null = null,
    tag = "",
  ) {
    this.benchmark = benchmark;
    this.substrate = substrate;
    this.mode = mode;
    this.k = k;
    this.seed = seed;
    this.tag = tag;
  }

  toString(): string {
    return ns(this.benchmark, this.substrate, this.mode, this.k, {
      seed: this.seed,
      tag: this.tag,
    });
  }

  runId(taskId: string, label: string): string {
    return `${this.toString()}/${taskId}/${label}`;
  }

  taskDir(root: string, taskId: string): string {
    return path.join(root, this.toString(), taskId.replace(/\//g, "__"));
  }
}

export class TaskResult {
  taskId: string;
  domain: string;
  k: number;
  seed: number | null;
  status = "running";
  inputs: string | null = null;
  modes: Record<string, unknown> = {};
  selections: Record<string, unknown> = {};
  base: unknown[] = [];
  errors: string[] = [];

  constructor(taskId: string, domain: string, k: number, seed: number | null = null) {
    this.taskId = taskId;
    this.domain = domain;
    this.k = k;
    this.seed = seed;
  }

  toDict(): Record<string, unknown> {
    return {
      task_id: this.taskId,
      domain: this.domain,
      k: this.k,
      seed: this.seed,
      status: this.status,
      inputs: this.inputs,
      base: this.base,
      modes: this.modes,
      selections: this.selections,
      errors: this.errors,
    };
  }
}

function modesOf(record: Record<string, unknown>): Record<string, unknown> {
  if ("modes" in record) return { ...((record.modes as object) || {}) };
  return { ...((record.arms as object) || {}) };
}

function taskInputs(adapter: BenchmarkAdapter, taskId: string): string | null {
  try {
    const prompt = adapter.taskPrompt(taskId);
    const filesDir = adapter.taskFiles(taskId);
    return runmark.inputsFingerprint(prompt, filesDir);
  } catch {
    return null;
  }
}

function mergedStatus(merged: Record<string, unknown>): string {
  const modes = (merged.modes as Record<string, unknown>) || {};
  const selections = (merged.selections as Record<string, unknown>) || {};
  const ok =
    Boolean(Object.keys(modes).length) &&
    !(merged.errors as unknown[] | undefined)?.length &&
    Object.entries(modes).every(([mode, value]) => {
      const sel = (selections[mode] as Record<string, unknown>) || {};
      return (
        Boolean((value as Record<string, unknown>)?.ok) &&
        Boolean(sel.ok) &&
        Boolean(sel.chosen_label)
      );
    });
  return ok ? "ok" : "partial";
}

function writeSummary(summaryPath: string, res: TaskResult): void {
  const lockPath = summaryPath.replace(/\.json$/, ".lock");
  fs.writeFileSync(lockPath, String(process.pid), "utf8");
  try {
    let merged = res.toDict();
    if (fs.existsSync(summaryPath)) {
      let old: Record<string, unknown> = {};
      try {
        old = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      } catch {
        old = {};
      }
      const inputsChanged =
        res.inputs != null && old.inputs != null && old.inputs !== res.inputs;
      if (!inputsChanged) {
        for (const key of ["modes", "selections"] as const) {
          const prev =
            key === "modes"
              ? modesOf(old)
              : { ...((old[key] as object) || {}) };
          Object.assign(prev, (merged[key] as object) || {});
          merged[key] = prev;
        }
        const errors = [...((merged.errors as string[]) || [])];
        const seen = new Set(errors.map((e) => JSON.stringify(e)));
        for (const e of (old.errors as string[]) || []) {
          if (e === "no base rollout produced anything" && (res.status === "ok" || res.status === "partial")) {
            continue;
          }
          const mode = String(e).split(":")[0]!;
          const modeOk = ((res.modes[mode] as Record<string, unknown>) || {}).ok;
          const sel = (res.selections[mode] as Record<string, unknown>) || {};
          if (modeOk && sel.ok && sel.chosen_label) continue;
          if (!seen.has(JSON.stringify(e))) errors.push(e);
        }
        merged.errors = errors;
        if (merged.status === "ok" || merged.status === "partial") {
          merged.status = mergedStatus(merged);
        }
      }
    }
    const tmp = summaryPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, summaryPath);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function treeIsBase(surface: harnessTree.SurfaceSpec, baseTree: Tree, tree: Tree): boolean {
  const chg = harnessTree.diffSummary(surface, baseTree, tree);
  return !(chg.added.length || chg.removed.length || chg.modified.length);
}

function resume(
  summaryPath: string,
  taskId: string,
  k: number,
  adapter: BenchmarkAdapter,
  runsRoot: string,
  modes: readonly string[],
  seed: number | null,
  tag: string,
  modeLibs: Record<string, libraryStore.Library>,
  res: TaskResult,
): boolean {
  let got: Record<string, unknown>;
  try {
    got = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (exc) {
    console.log(
      `  [${taskId}] unreadable summary.json (${exc instanceof Error ? exc.message : String(exc)}); re-running`,
    );
    return false;
  }
  if (got.status !== "ok" && got.status !== "partial") return false;
  if (got.inputs != null && res.inputs != null && got.inputs !== res.inputs) {
    console.log(
      `  [${taskId}] task inputs ${got.inputs} != ${res.inputs} -- re-running`,
    );
    return false;
  }
  const cachedModes = modesOf(got);
  const cachedSels = (got.selections as Record<string, Record<string, unknown>>) || {};
  const missing = [...modes]
    .filter(
      (m) =>
        !(
          (cachedModes[m] as Record<string, unknown> | undefined)?.ok &&
          cachedSels[m]?.ok &&
          cachedSels[m]?.chosen_label
        ),
    )
    .sort();
  if (missing.length) {
    console.log(
      `  [${taskId}] cached summary covers ${Object.keys(cachedModes).sort()}, re-running for ${missing}`,
    );
    return false;
  }
  for (const mode of modes) {
    const sel = cachedSels[mode]!;
    const namespace = new Namespace(adapter.spec.name, adapter.substrate.name, mode, k, seed, tag);
    const harnessDir = path.join(namespace.taskDir(runsRoot, taskId), "harnesses", String(sel.chosen_label));
    const runDir = String(sel.chosen_run_dir || "");
    try {
      if (!sel.chosen_run_dir || !fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
        throw new Error("adopted run directory is missing");
      }
      const artifact =
        sel.evidence === "trajectory" && adapter.spec.stateDeliverable
          ? adapter.trajectory(runDir, { obsTrunc: adapter.spec.obsTrunc })
          : adapter.delivered(runDir)
            ? adapter.deliverableText(runDir)
            : "";
      if (!artifact.trim() || artifact.startsWith("(no trajectory")) {
        throw new Error("adopted output is missing");
      }
      if (!harnessTree.isTree(adapter.substrate.surface(), harnessDir)) {
        throw new Error("adopted harness is missing");
      }
      const fp = sel.harness_fingerprint;
      if (fp && runmark.fingerprint(harnessDir) !== fp) {
        throw new Error("adopted harness has changed");
      }
    } catch (exc) {
      console.log(`  [${taskId}] cannot resume ${mode}: ${exc instanceof Error ? exc.message : String(exc)}; re-running`);
      return false;
    }
  }
  res.status = "skipped";
  res.base = (got.base as unknown[]) || [];
  res.modes = cachedModes;
  res.selections = cachedSels;
  res.errors = (got.errors as string[]) || [];
  for (const mode of modes) {
    const lib = modeLibs[mode];
    const sel = cachedSels[mode] || {};
    const label = String(sel.chosen_label || "");
    if (
      !lib ||
      !label ||
      !sel.ok ||
      !libraryStore.hasExperience(sel.experience as Record<string, unknown> | null | undefined)
    )
      continue;
    const n = new Namespace(adapter.spec.name, adapter.substrate.name, mode, k, seed, tag);
    const tree = harnessTree.readTree(
      adapter.substrate.surface(),
      path.join(n.taskDir(runsRoot, taskId), "harnesses", label),
    );
    if (!Object.keys(tree).length) continue;
    lib.add(taskId, tree, {
      why: String(sel.why || ""),
      label,
      runId: String(sel.chosen_run_id || ""),
      experience: (sel.experience as Record<string, unknown>) || {},
    });
  }
  return true;
}

function runOneMode(
  mode: string,
  taskId: string,
  k: number,
  base: RunView[],
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    selector: Proposer;
    n: Namespace;
    runsRoot: string;
    modeLib: libraryStore.Library | null;
    baseTree: Tree;
    surface: harnessTree.SurfaceSpec;
    poolPolicy: string;
    res: TaskResult;
  },
): void {
  const workDir = opts.n.taskDir(opts.runsRoot, taskId);
  const libDir = opts.modeLib ? opts.modeLib.contextDir() : null;
  const r = recursion.runMode(mode, taskId, k, base, {
    adapter: opts.adapter,
    prop: opts.prop,
    workDir,
    runIdOf: (lbl) => opts.n.runId(taskId, lbl),
    baseTree: opts.baseTree,
    libraryDir: libDir,
  });
  opts.res.modes[mode] = r.toDict();
  for (const stage of r.stages) {
    if (stage.executionFailed) {
      opts.res.errors.push(
        `${mode}: ${stage.label}: proposer execution failed: ${stage.error}`,
      );
    }
  }
  const candidates = selection.selectionPool(mode, k, r.rollouts, base);
  let sel: selection.Selection;
  if (opts.poolPolicy === "finals" && k === 1) {
    sel = selection.trivialSelection(taskId, k, mode, candidates, {
      adapter: opts.adapter,
      workDir,
    });
  } else {
    sel = selection.runSelection(taskId, k, mode, candidates, {
      adapter: opts.adapter,
      prop: opts.selector,
      workDir,
      poolKind: "finals",
    });
  }
  opts.res.selections[mode] = sel.toDict();
  if (opts.modeLib && sel.ok) {
    try {
      selection.reflectAdoption(taskId, sel, r.rollouts, {
        adapter: opts.adapter,
        prop: opts.selector,
        workDir,
        decisions: Object.fromEntries(r.stages.map((s) => [s.label, s.notes || s.error])),
      });
    } finally {
      opts.res.selections[mode] = sel.toDict();
    }
  }
  const d = sel.toDict() as Record<string, unknown>;
  d.selected_at = new Date().toISOString();
  d.chosen_run_dir = String(
    sel.chosenLabel in candidates ? candidates[sel.chosenLabel]!.runDir : "",
  );
  const chosenTree = r.trees[sel.chosenLabel] ?? opts.baseTree;
  d.chosen_tree_is_base = treeIsBase(opts.surface, opts.baseTree, chosenTree);
  if (sel.chosenLabel) {
    d.harness_fingerprint = runmark.fingerprint(path.join(workDir, "harnesses", sel.chosenLabel));
  }
  opts.res.selections[mode] = d;
  if (!sel.ok) opts.res.errors.push(`${mode}: selection failed: ${sel.error}`);
  const chosen = candidates[sel.chosenLabel];
  if (sel.ok && chosen && !chosen.delivered) {
    opts.res.errors.push(`${mode}: selected run ${chosen.runId} produced no deliverable`);
  }
  if (opts.modeLib && sel.ok && libraryStore.hasExperience(sel.experience)) {
    opts.modeLib.add(taskId, chosenTree, {
      why: sel.why,
      label: sel.chosenLabel,
      runId: sel.chosenRunId,
      experience: sel.experience,
    });
  }
}

export function runTask(
  taskId: string,
  k: number,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    runsRoot: string;
    modes?: readonly string[];
    seed?: number | null;
    tag?: string;
    library?: libraryStore.Library | null;
    libraries?: Record<string, libraryStore.Library> | null;
    selectorProp?: Proposer | null;
    poolPolicy?: string;
  },
): TaskResult {
  if (Math.trunc(k) < 1) throw new Error(`k must be positive, got ${JSON.stringify(k)}`);
  const modes = opts.modes ?? MODES;
  if (!modes.length || new Set(modes).size !== modes.length) {
    throw new Error("modes must contain at least one distinct recursion mode");
  }
  const unknown = [...new Set(modes)].filter((m) => !(MODES as readonly string[]).includes(m)).sort();
  if (unknown.length) throw new Error(`unknown modes ${unknown}; expected a subset of ${MODES}`);
  const poolPolicy = opts.poolPolicy ?? "finals";
  if (poolPolicy !== "finals") {
    throw new Error(`unknown pool_policy ${JSON.stringify(poolPolicy)}; this release builds exactly one selection pool, 'finals'`);
  }

  const modeLibs: Record<string, libraryStore.Library> = { ...(opts.libraries ?? {}) };
  if (opts.library) {
    if (Object.keys(modeLibs).length) throw new Error("pass either library or libraries, not both");
    if (modes.length !== 1) {
      throw new Error(
        "a shared mutable library would leak one mode into another; pass libraries={'agg': ..., 'seq': ...} instead",
      );
    }
    modeLibs[modes[0]!] = opts.library;
  }

  const selector =
    opts.selectorProp ??
    (opts.prop.spec === opts.adapter.spec.channels.selector
      ? opts.prop
      : opts.prop);

  const bench = opts.adapter.spec.name;
  const sub = opts.adapter.substrate.name;
  const seed = opts.seed ?? null;
  const tag = opts.tag ?? "";
  const domain = opts.adapter.domainOf(taskId);
  const res = new TaskResult(taskId, domain, k, seed);
  const baseNs = new Namespace(bench, sub, "agg", k, seed, tag);
  const work = baseNs.taskDir(opts.runsRoot, taskId);
  fs.mkdirSync(work, { recursive: true });
  const summaryPath = path.join(work, "summary.json");
  res.inputs = taskInputs(opts.adapter, taskId);

  if (fs.existsSync(summaryPath) && resume(summaryPath, taskId, k, opts.adapter, opts.runsRoot, modes, seed, tag, modeLibs, res)) {
    return res;
  }

  const surface = opts.adapter.substrate.surface();
  const baseTree = harnessTree.readTree(surface, opts.adapter.baseHarness());
  const labels = Array.from({ length: k }, (_, i) => `base${i + 1}`);
  const base: RunView[] = labels.map((label) => {
    const rid = baseNs.runId(taskId, label);
    try {
      const rd = opts.adapter.execute(taskId, null, rid);
      return {
        label,
        runId: rid,
        runDir: rd,
        ok: true,
        delivered: opts.adapter.delivered(rd),
      };
    } catch (exc) {
      return {
        label,
        runId: rid,
        runDir: path.join(work, "missing"),
        ok: false,
        delivered: false,
        error: `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  });
  res.base = base.map((b) => ({ label: b.label, run_id: b.runId, run_dir: b.runDir }));
  if (!base.some((b) => b.ok)) {
    const err = "no base rollout produced anything";
    res.status = "base-failed";
    res.errors.push(err);
    for (const mode of modes) {
      res.modes[mode] = { ok: false, error: err };
      res.selections[mode] = new selection.Selection(taskId, mode, k).toDict();
    }
    writeSummary(summaryPath, res);
    return res;
  }

  for (const mode of modes) {
    const n = new Namespace(bench, sub, mode, k, seed, tag);
    try {
      runOneMode(mode, taskId, k, base, {
        adapter: opts.adapter,
        prop: opts.prop,
        selector,
        n,
        runsRoot: opts.runsRoot,
        modeLib: modeLibs[mode] ?? null,
        baseTree,
        surface,
        poolPolicy,
        res,
      });
    } catch (exc) {
      const err = `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`;
      res.modes[mode] = { ok: false, error: err };
      res.selections[mode] = new selection.Selection(taskId, mode, k).toDict();
      (res.selections[mode] as Record<string, unknown>).error = err;
      res.errors.push(`${mode}: ${err}`);
    }
    res.status = "partial";
    writeSummary(summaryPath, res);
  }
  res.status = mergedStatus(res.toDict());
  writeSummary(summaryPath, res);
  return res;
}

export function runDomain(
  domain: string,
  taskIds: readonly string[],
  k: number,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    runsRoot: string;
    libraryRoot: string;
    modes?: readonly string[];
    seed?: number | null;
    tag?: string;
    selectorProp?: Proposer | null;
  },
): Record<string, unknown> {
  const modes = opts.modes ?? MODES;
  const surface = opts.adapter.substrate.surface();
  const libraries: Record<string, libraryStore.Library> = {};
  for (const mode of modes) {
    libraries[mode] = new libraryStore.Library(path.join(opts.libraryRoot, mode), domain, surface);
  }
  const tasks: Record<string, unknown>[] = [];
  let done = 0;
  let failed = 0;
  for (const taskId of taskIds) {
    const res = runTask(taskId, k, {
      adapter: opts.adapter,
      prop: opts.prop,
      runsRoot: opts.runsRoot,
      modes,
      seed: opts.seed ?? null,
      tag: opts.tag ?? "",
      libraries,
      selectorProp: opts.selectorProp ?? null,
    });
    tasks.push(res.toDict());
    if (res.status === "ok" || res.status === "skipped") done += 1;
    else if (res.status === "base-failed" || res.errors.length) failed += 1;
    else done += 1;
  }
  return { domain, k, n_tasks: taskIds.length, seed: opts.seed ?? null, done, failed, tasks };
}

export function taskStream(
  adapter: BenchmarkAdapter,
  opts: {
    split?: string;
    seed?: number | null;
    onlyDomains?: readonly string[];
    onlyTasks?: readonly string[];
    maxTasks?: number | null;
  } = {},
): Record<string, string[]> {
  const split = opts.split ?? "all";
  const byDomain: Record<string, string[]> = {};
  for (const t of adapter.tasks(split)) {
    const d = adapter.domainOf(t);
    (byDomain[d] ??= []).push(t);
  }
  if (opts.onlyDomains?.length) {
    const keep = new Set(opts.onlyDomains);
    const missing = [...keep].filter((d) => !(d in byDomain)).sort();
    if (missing.length) {
      throw new Error(
        `only_domains names unknown domain(s) ${missing}; split ${JSON.stringify(split)} has ${Object.keys(byDomain).sort()}`,
      );
    }
    for (const d of Object.keys(byDomain)) {
      if (!keep.has(d)) delete byDomain[d];
    }
  }
  if (opts.onlyTasks?.length) {
    const wanted = new Set(opts.onlyTasks);
    const have = new Set(Object.values(byDomain).flat());
    const missingT = [...wanted].filter((t) => !have.has(t)).sort();
    if (missingT.length) {
      throw new Error(
        `only_tasks names unknown task id(s) ${missingT} for split ${JSON.stringify(split)}`,
      );
    }
  }
  if (opts.maxTasks != null && opts.maxTasks < 1) {
    throw new Error(`max_tasks must be positive, got ${JSON.stringify(opts.maxTasks)}`);
  }

  const refFn = (adapter as { referenceDomainOrder?: () => string[] }).referenceDomainOrder;
  const reference = typeof refFn === "function" ? refFn.call(adapter) : defaultReferenceDomainOrder(byDomain);
  const stream = streamOrder(byDomain, opts.seed ?? null, reference);
  const ordered: Record<string, string[]> = {};
  const onlyTasks = opts.onlyTasks?.length ? new Set(opts.onlyTasks) : null;
  for (const [d, t] of stream) {
    if (onlyTasks && !onlyTasks.has(t)) continue;
    if (opts.maxTasks != null && (ordered[d]?.length ?? 0) >= opts.maxTasks) continue;
    (ordered[d] ??= []).push(t);
  }
  return ordered;
}

export function runSweep(
  k: number,
  opts: {
    adapter: BenchmarkAdapter;
    prop: Proposer;
    runsRoot: string;
    libraryRoot: string;
    split?: string;
    modes?: readonly string[];
    seed?: number | null;
    tag?: string;
    onlyDomains?: readonly string[];
    onlyTasks?: readonly string[];
    maxTasks?: number | null;
    selectorProp?: Proposer | null;
  },
): Record<string, unknown> {
  const modes = opts.modes ?? MODES;
  const orderedTasks = taskStream(opts.adapter, {
    split: opts.split,
    seed: opts.seed,
    onlyDomains: opts.onlyDomains,
    onlyTasks: opts.onlyTasks,
    maxTasks: opts.maxTasks,
  });
  const order = Object.keys(orderedTasks);
  const started = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const d of order) {
    try {
      rows.push(
        runDomain(d, orderedTasks[d]!, k, {
          adapter: opts.adapter,
          prop: opts.prop,
          runsRoot: opts.runsRoot,
          libraryRoot: opts.libraryRoot,
          modes,
          seed: opts.seed ?? null,
          tag: opts.tag ?? "",
          selectorProp: opts.selectorProp ?? null,
        }),
      );
    } catch (exc) {
      rows.push({
        domain: d,
        error: `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`,
      });
    }
  }
  return {
    benchmark: opts.adapter.spec.name,
    substrate: opts.adapter.substrate.name,
    k,
    modes: [...modes],
    seed: opts.seed ?? null,
    tag: opts.tag ?? "",
    domain_order: order,
    max_tasks: opts.maxTasks ?? null,
    only_tasks: [...(opts.onlyTasks ?? [])],
    started_at: started,
    finished_at: new Date().toISOString(),
    n_domains: order.length,
    domains: rows,
  };
}
