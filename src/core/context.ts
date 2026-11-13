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
import type { BenchmarkAdapter, RunView } from "./spec.js";
import type { Tree } from "./tree.js";

export class ContextTree {
  root: string;
  taskId: string;
  rollouts: string[];
  deliverables: string[];
  harnessFiles: number;
  library: boolean;
  pool: string[];
  failed: string[];
  deliverablesMode: string;
  sourceFiles: number;
  decisions: number;

  constructor(init: {
    root: string;
    taskId: string;
    rollouts: string[];
    deliverables: string[];
    harnessFiles: number;
    library: boolean;
    pool: string[];
    failed?: string[];
    deliverablesMode?: string;
    sourceFiles?: number;
    decisions?: number;
  }) {
    this.root = init.root;
    this.taskId = init.taskId;
    this.rollouts = init.rollouts;
    this.deliverables = init.deliverables;
    this.harnessFiles = init.harnessFiles;
    this.library = init.library;
    this.pool = init.pool;
    this.failed = init.failed ?? [];
    this.deliverablesMode = init.deliverablesMode ?? "contents";
    this.sourceFiles = init.sourceFiles ?? 0;
    this.decisions = init.decisions ?? 0;
  }

  get layout(): string {
    const lines = ["context/task.md                  the task as the agent received it"];
    if (this.sourceFiles) lines.push("context/source/                 task source materials");
    if (this.decisions) lines.push("context/decisions/              earlier edits and composition decisions");
    if (this.rollouts.length) {
      const names = this.rollouts.slice(0, 6).map((r) => `${r}.md`).join(", ");
      const more = this.rollouts.length > 6 ? ` (+${this.rollouts.length - 6} more)` : "";
      lines.push(`context/rollouts/               FULL trajectories: ${names}${more}`);
    }
    if (this.deliverables.length) {
      lines.push(
        "context/deliverables/<label>/    the files each rollout produced, one per artifact",
      );
    }
    if (this.harnessFiles) {
      lines.push(`context/harness/                the harness you are editing (${this.harnessFiles} files)`);
    }
    if (this.pool.length) {
      lines.push(
        `context/pool/                   ${this.pool.length} candidates, each with its harness and its rollout`,
      );
    }
    if (this.library) {
      lines.push(
        "context/library/                earlier tasks in this area -- browse INDEX.md first",
      );
    }
    return lines.join("\n");
  }
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyTree(src: string, dest: string): number {
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  const stack = [src];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const from = path.join(cur, ent.name);
      const rel = path.relative(src, from);
      const to = path.join(dest, rel);
      if (ent.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        stack.push(from);
      } else if (ent.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        n += 1;
      }
    }
  }
  return n;
}

/** Minimal fnmatch for `*` / `?` (Python `fnmatch.fnmatch` subset used by leak globs). */
function fnmatch(name: string, pattern: string): boolean {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i").test(name);
}

export function assertNoLeakPaths(root: string, patterns: readonly string[]): void {
  if (!patterns.length || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
  const hits: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      for (const pattern of patterns) {
        const pat = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "");
        if (fnmatch(rel, pat) || fnmatch(rel, `*/${pat}`)) {
          hits.push(rel);
          break;
        }
      }
    }
  }
  if (hits.length) {
    const shown = hits.slice().sort().slice(0, 8).join(", ");
    throw new Error(`answer-key path(s) would enter model context: ${shown}`);
  }
}

export const GRADER_VERDICT_MARKERS: readonly string[] = [
  "deterministic_eval_summary",
  "deterministic_eval_result",
  "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result",
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"',
];

export function assertNoGraderVerdicts(root: string): void {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const marker of GRADER_VERDICT_MARKERS) {
        if (text.includes(marker)) {
          throw new Error(
            `grader verdict leaked into evidence: ${path.relative(root, full).split(path.sep).join("/")}`,
          );
        }
      }
    }
  }
}

const MARKER_SCAN_SUFFIXES = new Set(
  [
    ".md",
    ".txt",
    ".json",
    ".csv",
    ".tsv",
    ".yaml",
    ".yml",
    ".html",
    ".htm",
    ".log",
    ".py",
    ".js",
    ".sh",
    ".xml",
    ".ini",
    ".toml",
    ".patch",
    ".diff",
    "",
  ].map((s) => s.toLowerCase()),
);

export function assertTreeHasNoGraderVerdicts(
  tree: Tree | Record<string, string>,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  for (const rel of Object.keys(tree).sort()) {
    for (const m of markers) {
      if (rel.includes(m)) {
        throw new Error(
          `harness file ${JSON.stringify(rel)} has grader-verdict marker ${JSON.stringify(m)} in its NAME`,
        );
      }
    }
    if (!MARKER_SCAN_SUFFIXES.has(path.extname(rel).toLowerCase())) continue;
    const body = String(tree[rel]);
    for (const m of markers) {
      const where = body.indexOf(m);
      if (where >= 0) {
        throw new Error(
          `harness file ${JSON.stringify(rel)} contains grader-verdict marker ${JSON.stringify(m)} at offset ${where}`,
        );
      }
    }
  }
}

export function copySource(adapter: BenchmarkAdapter, taskId: string, dest: string): number {
  const files = adapter.taskFiles(taskId);
  if (!files || !fs.existsSync(files) || !fs.statSync(files).isDirectory()) return 0;
  const dst = path.join(dest, "source");
  let n = 0;
  const stack = [files];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const from = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__pycache__") continue;
        stack.push(from);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(files, from).split(path.sep).join("/");
      const leak = [...adapter.spec.leakGlobs].some((g) => {
        const pat = String(g).replace(/\\/g, "/").replace(/^\.\//, "");
        return fnmatch(rel, pat) || fnmatch(rel, `*/${pat}`);
      });
      if (leak) continue;
      const to = path.join(dst, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      n += 1;
    }
  }
  if (n) assertNoLeakPaths(dst, adapter.spec.leakGlobs);
  return n;
}

function writeRollout(
  dest: string,
  r: RunView,
  adapter: BenchmarkAdapter,
  trunc: number,
  namesOnly: boolean,
): string | null {
  try {
    const traj = adapter.trajectory(r.runDir, { obsTrunc: trunc });
    fs.writeFileSync(path.join(dest, "rollouts", `${r.label}.md`), traj, "utf8");
  } catch (exc) {
    return `${r.label}: ${exc instanceof Error ? exc.message : String(exc)}`;
  }
  const ddir = path.join(dest, "deliverables", r.label);
  fs.mkdirSync(ddir, { recursive: true });
  try {
    if (namesOnly) {
      const files = Object.keys(adapter.deliverableFiles(r.runDir));
      fs.writeFileSync(
        path.join(ddir, "INDEX.md"),
        files.map((f) => `- ${f}`).join("\n") + "\n",
        "utf8",
      );
    } else {
      const files = adapter.deliverableFiles(r.runDir);
      const names: string[] = [];
      for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(ddir, name), text, "utf8");
        names.push(name);
      }
      fs.writeFileSync(
        path.join(ddir, "INDEX.md"),
        names.map((f) => `- ${f}`).join("\n") + "\n",
        "utf8",
      );
    }
  } catch {
    /* deliverable failure is itself evidence */
  }
  return null;
}

function writePool(
  dest: string,
  pool: ReadonlyArray<readonly [string, string, RunView | null | undefined]>,
  adapter: BenchmarkAdapter,
  trunc: number,
  namesOnly: boolean,
): string[] {
  const got: string[] = [];
  if (!pool.length) return got;
  fs.mkdirSync(path.join(dest, "pool"), { recursive: true });
  for (const [label, harnessDir, run] of pool) {
    const pdir = path.join(dest, "pool", label);
    fs.mkdirSync(pdir, { recursive: true });
    if (harnessDir && fs.existsSync(harnessDir)) {
      copyTree(harnessDir, path.join(pdir, "harness"));
      fs.writeFileSync(path.join(pdir, "harness.diff"), `harness: ${label}\n`, "utf8");
    }
    if (run) {
      try {
        fs.writeFileSync(
          path.join(pdir, "rollout.md"),
          adapter.trajectory(run.runDir, { obsTrunc: trunc }),
          "utf8",
        );
      } catch {
        /* ignore */
      }
      if (!namesOnly) {
        try {
          fs.writeFileSync(
            path.join(pdir, "deliverable.md"),
            adapter.deliverableText(run.runDir),
            "utf8",
          );
        } catch {
          /* ignore */
        }
      }
    }
    got.push(label);
  }
  return got;
}

export function build(
  dest: string,
  adapter: BenchmarkAdapter,
  taskId: string,
  rollouts: readonly RunView[] = [],
  opts: {
    harnessDir?: string | null;
    libraryDir?: string | null;
    pool?: ReadonlyArray<readonly [string, string, RunView | null | undefined]>;
    decisions?: Record<string, string> | null;
    obsTrunc?: number | null;
  } = {},
): ContextTree {
  if (fs.existsSync(dest)) rmrf(dest);
  fs.mkdirSync(dest, { recursive: true });
  const trunc = opts.obsTrunc ?? adapter.spec.obsTrunc;
  fs.writeFileSync(path.join(dest, "task.md"), adapter.taskPrompt(taskId), "utf8");
  const sourceFiles = copySource(adapter, taskId, dest);
  const decisions = opts.decisions ?? {};
  for (const [label, notes] of Object.entries(decisions)) {
    const p = path.join(dest, "decisions", `${label}.md`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, notes || "No decision notes returned.", "utf8");
  }

  const gotR: string[] = [];
  const gotD: string[] = [];
  const failedR: string[] = [];
  if (rollouts.length) {
    fs.mkdirSync(path.join(dest, "rollouts"), { recursive: true });
    fs.mkdirSync(path.join(dest, "deliverables"), { recursive: true });
  }
  const namesOnly = adapter.spec.proposerDeliverables === "names";
  for (const r of rollouts) {
    const failure = writeRollout(dest, r, adapter, trunc, namesOnly);
    if (failure) failedR.push(failure);
    else gotR.push(r.label);
    gotD.push(r.label);
  }

  let nH = 0;
  if (opts.harnessDir && fs.existsSync(opts.harnessDir) && fs.statSync(opts.harnessDir).isDirectory()) {
    assertNoLeakPaths(opts.harnessDir, adapter.spec.leakGlobs);
    nH = copyTree(opts.harnessDir, path.join(dest, "harness"));
  }

  const gotP = writePool(dest, opts.pool ?? [], adapter, trunc, namesOnly);

  let lib = false;
  if (
    opts.libraryDir &&
    fs.existsSync(opts.libraryDir) &&
    fs.statSync(opts.libraryDir).isDirectory() &&
    fs.readdirSync(opts.libraryDir).length
  ) {
    assertNoLeakPaths(opts.libraryDir, adapter.spec.leakGlobs);
    copyTree(opts.libraryDir, path.join(dest, "library"));
    lib = true;
  }

  assertNoLeakPaths(dest, adapter.spec.leakGlobs);
  assertNoGraderVerdicts(dest);

  if (rollouts.length && !gotR.length) {
    throw new Error(
      "no trajectory could be rendered for ANY rollout -- the proposer would be adapting on nothing: " +
        failedR.slice(0, 4).join("; "),
    );
  }

  return new ContextTree({
    root: dest,
    taskId,
    rollouts: gotR,
    deliverables: gotD,
    harnessFiles: nH,
    library: lib,
    pool: gotP,
    failed: failedR,
    deliverablesMode: adapter.spec.proposerDeliverables,
    sourceFiles,
    decisions: Object.keys(decisions).length,
  });
}

export function mission(tree: ContextTree, opts: { job: string }): string {
  return [
    "# MISSION",
    "",
    opts.job,
    "",
    "## Evidence layout",
    tree.layout,
    "",
    "Work only from the files under `context/`. Edit `context/harness/` in place when proposing a harness.",
  ].join("\n");
}
