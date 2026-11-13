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

/** The per-domain experience library R. */

import fs from "node:fs";
import path from "node:path";
import * as context from "./context.js";
import * as harnessTree from "./tree.js";
import type { SurfaceSpec, Tree } from "./tree.js";

export function slug(taskId: string): string {
  return taskId.replace(/\//g, "__");
}

export function hasExperience(experience: Record<string, unknown> | null | undefined): boolean {
  if (experience == null || typeof experience !== "object") return false;
  return (["cue", "lesson", "evidence"] as const).every(
    (key) =>
      typeof experience[key] === "string" && (experience[key] as string).trim().length > 0,
  );
}

export function domainDir(domain: string): string {
  const collapsed = domain.replace(/\s*[/\\]\s*/g, "__").trim();
  return collapsed || "unknown";
}

export class Library {
  root: string;
  domain: string;
  surface: SurfaceSpec;

  constructor(root: string, domain: string, surface: SurfaceSpec) {
    this.root = root;
    this.domain = domain;
    this.surface = surface;
  }

  get dir(): string {
    return path.join(this.root, domainDir(this.domain));
  }

  get index(): string {
    return path.join(this.dir, "INDEX.md");
  }

  entryDir(taskId: string): string {
    return path.join(this.dir, "harnesses", slug(taskId));
  }

  exists(): boolean {
    return fs.existsSync(this.index) && fs.statSync(this.index).isFile();
  }

  contextDir(): string | null {
    if (!this.exists()) return null;
    let found = false;
    const walk = (d: string): void => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name === "EXPERIENCE.md") found = true;
      }
    };
    if (fs.existsSync(this.dir)) walk(this.dir);
    return found ? this.dir : null;
  }

  entries(): string[] {
    const d = path.join(this.dir, "harnesses");
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return [];
    return fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  treeOf(taskId: string): Tree {
    return harnessTree.readTree(this.surface, path.join(this.entryDir(taskId), "harness"));
  }

  forget(taskIds: readonly string[]): void {
    let removed = false;
    for (const tid of taskIds) {
      const d = this.entryDir(tid);
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        fs.rmSync(d, { recursive: true, force: true });
        removed = true;
      }
    }
    if (removed) this.rebuildIndex();
  }

  retain(taskIds: readonly string[]): void {
    const keep = new Set(taskIds.map(slug));
    this.forget(this.entries().filter((e) => !keep.has(e)));
  }

  add(
    taskId: string,
    harness: Tree,
    opts: {
      why?: string;
      label?: string;
      runId?: string;
      experience?: Record<string, unknown> | null;
    } = {},
  ): string | null {
    const experience = opts.experience ?? null;
    if (!hasExperience(experience)) return null;
    context.assertTreeHasNoGraderVerdicts(harness);
    context.assertTreeHasNoGraderVerdicts({
      "EXPERIENCE.md": String(experience) + (opts.why ?? ""),
    });
    const d = this.entryDir(taskId);
    const harnessDest = path.join(d, "harness");
    fs.rmSync(harnessDest, { recursive: true, force: true });
    fs.mkdirSync(harnessDest, { recursive: true });
    harnessTree.writeTree(this.surface, harness, harnessDest, { stubs: false });
    const exp = experience ?? {};
    const lines: string[] = [
      `# ${taskId}`,
      "",
      `- adopted: \`${opts.label ?? ""}\`` +
        (opts.runId ? `  (run \`${opts.runId}\`)` : ""),
      `- components: ${inventory(this.surface, harness)}`,
      "",
    ];
    if ((opts.why ?? "").trim()) {
      lines.push("## Why this was chosen", opts.why!.trim(), "");
    }
    if (exp.edits) {
      lines.push("## What each edit did", String(exp.edits).trim(), "");
    }
    if (exp.lesson) {
      lines.push("## Transferable lesson");
      for (const f of ["cue", "lesson", "evidence", "confidence"] as const) {
        if (exp[f]) lines.push(`- **${f}**: ${String(exp[f]).trim()}`);
      }
      lines.push("");
    }
    fs.writeFileSync(path.join(d, "EXPERIENCE.md"), lines.join("\n"), "utf8");
    this.rebuildIndex();
    return d;
  }

  rebuildIndex(): string {
    const rows: string[] = [
      `# Library — ${this.domain}`,
      "",
      "Each entry is an earlier task in THIS domain whose harness was chosen, stored ",
      "with its FULL component tree and why it was picked. Browse this index, then ",
      "open the entries that look relevant to the matter in front of you.",
      "",
    ];
    const names = this.entries();
    if (!names.length) {
      rows.push("_(empty — this is the first task in this domain)_");
    }
    for (const name of names) {
      const ed = path.join(this.dir, "harnesses", name);
      const cue = fieldFromExperience(path.join(ed, "EXPERIENCE.md"), "cue");
      const tree = harnessTree.readTree(this.surface, path.join(ed, "harness"));
      rows.push(
        `## \`harnesses/${name}/\``,
        `- harness: \`harnesses/${name}/harness/\` — ${inventory(this.surface, tree)}`,
        `- why:     \`harnesses/${name}/EXPERIENCE.md\``,
      );
      if (cue) rows.push(`- cue:     ${cue}`);
      rows.push("");
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.index, rows.join("\n"), "utf8");
    return this.index;
  }
}

function inventory(surface: SurfaceSpec, tree: Tree): string {
  const st: Record<string, number> = { skills: 0, sub_agents: 0, scripts: 0 };
  const skillPrefix = `${surface.skillDir}/`;
  const pluginPrefix = surface.pluginDir != null ? `${surface.pluginDir}/` : null;
  const hooksFile = surface.hooksFile;
  for (const rel of Object.keys(tree)) {
    if (rel.startsWith(skillPrefix) && rel.endsWith("SKILL.md")) st.skills = (st.skills ?? 0) + 1;
    else if (rel.startsWith("sub_agents/")) st.sub_agents = (st.sub_agents ?? 0) + 1;
    else if (rel.startsWith("scripts/")) st.scripts = (st.scripts ?? 0) + 1;
    else if (pluginPrefix != null && rel.startsWith(pluginPrefix))
      st.plugins = (st.plugins ?? 0) + 1;
    else if (hooksFile != null && rel === hooksFile) st.hooks = (st.hooks ?? 0) + 1;
  }
  const on = harnessTree.alwaysOnText(surface, tree).length;
  const bits = Object.entries(st)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k}`);
  const summary = bits.length ? bits.join(", ") : "always-on edits only";
  return `${summary}; ${on.toLocaleString("en-US")} always-on chars`;
}

function fieldFromExperience(file: string, name: string): string {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return "";
  const prefix = `- **${name}**:`;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return "";
}

export function rootFor(
  base: string,
  opts: { benchmark: string; k: number; variant?: string; tag?: string },
): string {
  if (opts.tag) return path.join(base, opts.benchmark, opts.tag);
  const parts = [`k${Math.trunc(opts.k)}`];
  if (opts.variant) parts.push(opts.variant);
  return path.join(base, opts.benchmark, parts.join("-"));
}
