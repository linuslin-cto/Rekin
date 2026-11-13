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

/** Trial identity: was this rollout finished, and by this configuration? */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MARK = ".adapt_complete";

export const RUNMARK_VERSION = 1;

function ignored(p: string): boolean {
  const parts = p.split(/[/\\]/);
  const base = path.basename(p);
  return parts.includes("__pycache__") || path.extname(p) === ".pyc" || base === ".DS_Store";
}

function walkFilesSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    const ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) out.push(full);
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

export function fingerprint(harnessDir: string | null | undefined): string {
  if (harnessDir == null) return "base";
  const root = path.resolve(harnessDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "absent";
  const h = createHash("sha1");
  for (const p of walkFilesSorted(root)) {
    if (ignored(p) || path.basename(p) === MARK) continue;
    const rel = path.relative(root, p).split(path.sep).join("/");
    h.update(rel);
    h.update("\0");
    try {
      h.update(fs.readFileSync(p));
    } catch {
      h.update("<unreadable>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function inputsFingerprint(
  taskPrompt: string,
  filesDir: string | null | undefined,
): string {
  const h = createHash("sha1");
  h.update("prompt\0");
  h.update(taskPrompt);
  h.update("\0");
  const root = filesDir != null ? path.resolve(filesDir) : null;
  if (root != null && fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    for (const p of walkFilesSorted(root)) {
      if (ignored(p)) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      h.update(rel);
      h.update("\0");
      try {
        h.update(fs.readFileSync(p));
      } catch {
        h.update("<unreadable>");
      }
      h.update("\0");
    }
  }
  return h.digest("hex").slice(0, 16);
}

export function markComplete(
  where: string,
  opts: {
    runId: string;
    harnessDir?: string | null;
    inputs?: string | null;
    extra?: Record<string, unknown> | null;
  },
): string {
  const d = path.resolve(where);
  fs.mkdirSync(d, { recursive: true });
  const payload: Record<string, unknown> = {
    version: RUNMARK_VERSION,
    run_id: opts.runId,
    at: Date.now() / 1000,
    harness: fingerprint(opts.harnessDir),
    ...(opts.extra ?? {}),
  };
  if (opts.inputs != null) payload.inputs = opts.inputs;
  const tmp = path.join(d, `${MARK}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  const final = path.join(d, MARK);
  fs.renameSync(tmp, final);
  return final;
}

export function readMark(where: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(path.join(path.resolve(where), MARK), "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function inputsMatch(m: Record<string, unknown>, inputs: string | null | undefined): boolean {
  const recorded = m.inputs;
  return recorded === undefined || inputs == null || recorded === inputs;
}

export function isComplete(
  where: string,
  opts: {
    harnessDir?: string | null;
    matchHarness?: boolean;
    inputs?: string | null;
  } = {},
): boolean {
  const matchHarness = opts.matchHarness ?? true;
  const m = readMark(where);
  if (!m || m.version !== RUNMARK_VERSION) return false;
  if (opts.inputs != null && !inputsMatch(m, opts.inputs)) return false;
  if (!matchHarness) return true;
  return m.harness === fingerprint(opts.harnessDir);
}

export function whyNot(
  where: string,
  opts: { harnessDir?: string | null; inputs?: string | null } = {},
): string {
  const m = readMark(where);
  if (!m) {
    return `no ${MARK} -- never finished, or finished before completion was recorded`;
  }
  if (m.version !== RUNMARK_VERSION) {
    return `marker version ${String(m.version)} != ${RUNMARK_VERSION}`;
  }
  if (!inputsMatch(m, opts.inputs)) {
    return (
      `task inputs ${String(m.inputs)} != ${String(opts.inputs)} -- the task prompt or its source ` +
      `files changed since this rollout finished`
    );
  }
  const want = fingerprint(opts.harnessDir);
  const got = m.harness;
  if (want !== got) {
    return `harness fingerprint ${String(got)} != ${want} -- produced by a different configuration`;
  }
  return "reusable";
}
