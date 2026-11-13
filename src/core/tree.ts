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

/** The c1..c8 component tree: read, validate, write, diff — parametrised by SurfaceSpec. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Tree = Record<string, string>;

export const RESERVED_SCRIPTS = new Set(["read_doc.py", "pack.py", "unpack.py"]);

const NAME = "[a-z0-9][a-z0-9_\\-]*";

export interface SurfaceSpec {
  name: string;
  alwaysOn: readonly string[];
  alwaysOnMax: number;
  alwaysOnCapReason: string;
  skillDir: string;
  skillNameRule: string;
  triggerHint: string;
  autotriggerFile: string;
  triggerLine: string;
  subagentRequiresMode: boolean;
  pluginDir: string | null;
  hooksFile: string | null;
  hookEvents?: ReadonlySet<string>;
  compileSkillScripts?: boolean;
  rejectEmptyAlwaysOn?: boolean;
  stubs?: ReadonlyArray<readonly [string, string]>;
}

interface RxBag {
  skill: RegExp;
  skillScript: RegExp;
  subagent: RegExp;
  script: RegExp;
  scriptRef: RegExp;
  plugin?: RegExp;
}

const rxCache = new Map<string, RxBag>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rx(surface: SurfaceSpec): RxBag {
  const key = `${surface.name}|${surface.skillDir}|${surface.pluginDir ?? ""}`;
  const hit = rxCache.get(key);
  if (hit) return hit;
  const sd = escapeRe(surface.skillDir);
  const out: RxBag = {
    skill: new RegExp(`^${sd}/(${NAME})/SKILL\\.md$`),
    skillScript: new RegExp(`^${sd}/${NAME}/scripts/[A-Za-z0-9_.\\-]+$`),
    subagent: new RegExp(`^sub_agents/(${NAME})/AGENT\\.md$`),
    script: /^scripts\/[a-z0-9_][a-z0-9_]*\.py$/,
    scriptRef: new RegExp(
      `(?:python3?\\s+)((?:${sd}/[\\w\\-]+/)?scripts/[\\w.\\-]+\\.py)`,
      "g",
    ),
  };
  if (surface.pluginDir != null) {
    out.plugin = new RegExp(`^${escapeRe(surface.pluginDir)}/(${NAME})\\.ts$`);
  }
  rxCache.set(key, out);
  return out;
}

export function normalizeRel(rel: string): string {
  let r = String(rel).trim().replace(/\\/g, "/");
  if (r.startsWith("/") || r.split("/").includes("..")) {
    throw new Error(`path escapes the harness: ${JSON.stringify(rel)}`);
  }
  while (r.startsWith("./")) r = r.slice(2);
  return r.replace(/^\/+|\/+$/g, "");
}

export function isAllowed(surface: SurfaceSpec, rel: string): boolean {
  try {
    rel = normalizeRel(rel);
  } catch {
    return false;
  }
  if (surface.alwaysOn.includes(rel)) return true;
  if (surface.hooksFile != null && rel === surface.hooksFile) return true;
  const r = rx(surface);
  if (
    r.skill.test(rel) ||
    r.skillScript.test(rel) ||
    r.subagent.test(rel) ||
    r.script.test(rel)
  ) {
    return true;
  }
  return Boolean(r.plugin?.test(rel));
}

export function skillNames(surface: SurfaceSpec, tree: Tree): string[] {
  const r = rx(surface).skill;
  const names = new Set<string>();
  for (const rel of Object.keys(tree)) {
    const m = rel.match(r);
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

export function subagentNames(surface: SurfaceSpec, tree: Tree): string[] {
  const r = rx(surface).subagent;
  const names = new Set<string>();
  for (const rel of Object.keys(tree)) {
    const m = rel.match(r);
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

function stubPaths(surface: SurfaceSpec): Set<string> {
  return new Set((surface.stubs ?? []).map(([rel]) => rel));
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__pycache__" || ent.name === "node_modules") continue;
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export function readTree(
  surface: SurfaceSpec,
  d: string,
  opts: { rejected?: string[] } = {},
): Tree {
  const out: Tree = {};
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return out;
  const stubs = stubPaths(surface);
  for (const p of walkFiles(d)) {
    const rel = path.relative(d, p).split(path.sep).join("/");
    if (stubs.has(rel)) continue;
    if (!isAllowed(surface, rel)) {
      opts.rejected?.push(rel);
      continue;
    }
    out[rel] = fs.readFileSync(p, "utf8");
  }
  return out;
}

export function isTree(surface: SurfaceSpec, d: string): boolean {
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return false;
  return surface.alwaysOn.some((a) => fs.existsSync(path.join(d, a)) && fs.statSync(path.join(d, a)).isFile());
}

export function writeTree(
  surface: SurfaceSpec,
  tree: Tree,
  dest: string,
  opts: { stubs?: boolean } = {},
): string {
  const stubs = opts.stubs !== false;
  fs.mkdirSync(dest, { recursive: true });
  const stubSet = stubPaths(surface);
  for (const p of walkFiles(dest).reverse()) {
    const rel = path.relative(dest, p).split(path.sep).join("/");
    if (isAllowed(surface, rel) || stubSet.has(rel)) fs.unlinkSync(p);
  }
  for (const a of surface.alwaysOn) {
    const p = path.join(dest, a);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!(a in tree) && !fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
  }
  for (const [rel, content] of Object.entries(tree)) {
    const p = path.join(dest, normalizeRel(rel));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  if (stubs) {
    for (const [rel, body] of surface.stubs ?? []) {
      const p = path.join(dest, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, body, "utf8");
    }
  }
  return dest;
}

export function alwaysOnText(surface: SurfaceSpec, tree: Tree): string {
  return surface.alwaysOn.map((a) => tree[a] ?? "").join("\n\n");
}

export function autotrigger(
  surface: SurfaceSpec,
  tree: Tree,
  opts: { alwaysOnMax?: number } = {},
): string[] {
  const cap = opts.alwaysOnMax ?? surface.alwaysOnMax;
  let body = alwaysOnText(surface, tree);
  const fixed: string[] = [];
  for (const name of skillNames(surface, tree)) {
    if (body.includes(name)) continue;
    const fm = (tree[`${surface.skillDir}/${name}/SKILL.md`] ?? "").slice(0, 600);
    const m = fm.match(/^description:\s*(.+)$/m);
    const desc = m ? m[1]!.trim().replace(/\.$/, "") : `the ${name} workflow applies`;
    const line = surface.triggerLine.replaceAll("{name}", name).replaceAll("{desc}", desc);
    const cur = tree[surface.autotriggerFile] ?? "";
    if (alwaysOnText(surface, tree).length + line.length + 2 > cap) continue;
    tree[surface.autotriggerFile] = cur.trim() ? `${cur.replace(/\s+$/, "")}\n${line}` : line;
    body = alwaysOnText(surface, tree);
    fixed.push(name);
  }
  return fixed;
}

export function checkHooks(surface: SurfaceSpec, src: string, errs: string[]): void {
  const hf = surface.hooksFile;
  let doc: unknown;
  try {
    doc = JSON.parse(src);
  } catch (exc) {
    errs.push(`${hf} is not valid JSON: ${String(exc)}`);
    return;
  }
  const hooks =
    doc && typeof doc === "object" && "hooks" in doc
      ? (doc as { hooks: unknown }).hooks
      : null;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks) || !Object.keys(hooks).length) {
    errs.push(`${hf} needs a top-level {"hooks": {"<Event>": [...]}} object`);
    return;
  }
  const events = surface.hookEvents ?? new Set<string>();
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!events.has(event)) {
      errs.push(
        `${hf}: unknown event ${JSON.stringify(event)}; the framework dispatches ${[...events].sort().join(", ")} (PascalCase)`,
      );
      continue;
    }
    if (!Array.isArray(entries)) {
      errs.push(`${hf}: ${event} must map to a LIST of matcher entries`);
      continue;
    }
    entries.forEach((entry, i) => {
      if (!entry || typeof entry !== "object" || !Array.isArray((entry as { hooks?: unknown }).hooks)) {
        errs.push(`${hf}: ${event}[${i}] needs a \`hooks\` list`);
        return;
      }
      for (const h of (entry as { hooks: unknown[] }).hooks) {
        if (!h || typeof h !== "object" || (h as { type?: string }).type !== "command") {
          errs.push(
            `${hf}: ${event}[${i}] hook type must be "command" — async/prompt/agent hooks are skipped as 'not supported yet'`,
          );
        } else if (!String((h as { command?: string }).command ?? "").trim()) {
          errs.push(`${hf}: ${event}[${i}] has an empty \`command\``);
        }
      }
    });
  }
}

function pythonCmd(): string {
  for (const c of ["python", "python3", "py"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return "python";
}

function pyCompiles(rel: string, src: string, errs: string[]): void {
  if (!src.trim()) {
    errs.push(`${rel} does not compile: empty script`);
    return;
  }
  if (src.includes("\0")) {
    errs.push(`${rel} does not compile: null byte in source`);
    return;
  }
  const py = pythonCmd();
  const args =
    py === "py"
      ? ["-3", "-c", "import sys; compile(sys.stdin.read(), sys.argv[1], 'exec')", rel]
      : ["-c", "import sys; compile(sys.stdin.read(), sys.argv[1], 'exec')", rel];
  const r = spawnSync(py, args, { input: src, encoding: "utf8" });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 160);
    errs.push(`${rel} does not compile: ${detail}`);
  }
}

function checkSkills(surface: SurfaceSpec, tree: Tree, body: string, errs: string[]): string[] {
  const skills = skillNames(surface, tree);
  for (const name of skills) {
    const fm = tree[`${surface.skillDir}/${name}/SKILL.md`]!.slice(0, 600);
    if (!/^description:\s*\S/m.test(fm)) {
      errs.push(
        `${surface.skillDir}/${name}/SKILL.md needs a \`description:\` in its frontmatter, or the skill is dropped SILENTLY at load`,
      );
    }
    const mName = fm.match(/^name:\s*(\S+)\s*$/m);
    if (surface.skillNameRule === "must_match") {
      if (!(mName && mName[1] === name)) {
        errs.push(
          `${surface.skillDir}/${name}/SKILL.md needs frontmatter \`name: ${name}\` matching its directory (a mismatch is dropped SILENTLY at load)`,
        );
      }
    } else if (mName && mName[1] !== name) {
      errs.push(
        `${surface.skillDir}/${name}/SKILL.md frontmatter \`name: ${mName[1]}\` OVERRIDES the directory name at load, so every trigger line naming \`${name}\` stops matching; drop the \`name:\` line or make it \`name: ${name}\``,
      );
    }
    if (!body.includes(name)) {
      errs.push(
        `skill '${name}' is never named in the always-on text, so the agent will not know to invoke it — an untriggered skill is dead weight. ${surface.triggerHint.replaceAll("{name}", name)}`,
      );
    }
  }
  return skills;
}

function checkSubagents(
  surface: SurfaceSpec,
  tree: Tree,
  allowSubagents: boolean,
  errs: string[],
): string[] {
  const subs = subagentNames(surface, tree);
  if (subs.length && !allowSubagents) {
    errs.push(`sub_agents are not available on this deployment: ${subs}`);
  }
  for (const name of subs) {
    const fm = tree[`sub_agents/${name}/AGENT.md`]!.slice(0, 600);
    if (surface.subagentRequiresMode && !/^mode:\s*subagent\s*$/m.test(fm)) {
      errs.push(`sub_agents/${name}/AGENT.md needs frontmatter \`mode: subagent\``);
    }
    if (!/^description:\s*\S/m.test(fm)) {
      errs.push(`sub_agents/${name}/AGENT.md needs a \`description:\``);
    }
  }
  return subs;
}

function checkScriptRefs(
  surface: SurfaceSpec,
  tree: Tree,
  r: RxBag,
  reservedScripts: Set<string>,
  errs: string[],
): void {
  const have = new Set(
    Object.keys(tree).filter((rel) => r.script.test(rel) || r.skillScript.test(rel)),
  );
  for (const [rel, src] of Object.entries(tree)) {
    if (!(r.skill.test(rel) || surface.alwaysOn.includes(rel))) continue;
    const re = new RegExp(r.scriptRef.source, "g");
    for (const m of src.matchAll(re)) {
      const ref = m[1]!;
      const base = ref.split("/").pop()!;
      if (reservedScripts.has(base)) continue;
      if (!have.has(ref)) {
        errs.push(`${rel} invokes \`${ref}\` but that file is not in the harness`);
      }
    }
  }
}

export function validate(
  surface: SurfaceSpec,
  tree: Tree,
  opts: {
    allowSubagents?: boolean;
    alwaysOnMax?: number;
    reservedScripts?: Set<string>;
  } = {},
): Record<string, number> {
  const errs: string[] = [];
  const r = rx(surface);
  const cap = opts.alwaysOnMax ?? surface.alwaysOnMax;
  const body = alwaysOnText(surface, tree);
  const allowSubagents = opts.allowSubagents ?? true;
  const reservedScripts = opts.reservedScripts ?? RESERVED_SCRIPTS;

  if (body.length > cap) {
    errs.push(
      `always-on content is ${body.length} chars, over the ${cap} cap; ${surface.alwaysOnCapReason}`,
    );
  }
  if (surface.rejectEmptyAlwaysOn && !body.trim()) {
    errs.push(
      `${surface.alwaysOn[0]} is empty — it is the only always-on file on this framework, so an empty one is a harness that does not exist`,
    );
  }

  const skills = checkSkills(surface, tree, body, errs);
  const subs = checkSubagents(surface, tree, allowSubagents, errs);

  for (const [rel, src] of Object.entries(tree)) {
    if (
      r.script.test(rel) ||
      (surface.compileSkillScripts && r.skillScript.test(rel) && rel.endsWith(".py"))
    ) {
      pyCompiles(rel, src, errs);
    }
  }

  if (surface.hooksFile != null && surface.hooksFile in tree) {
    checkHooks(surface, tree[surface.hooksFile]!, errs);
  }

  checkScriptRefs(surface, tree, r, reservedScripts, errs);

  if (errs.length) throw new Error(errs.join(" | "));

  const out: Record<string, number> = {
    always_on_chars: body.length,
    n_files: Object.keys(tree).length,
    skills: skills.length,
    sub_agents: subs.length,
    scripts: Object.keys(tree).filter((rel) => r.script.test(rel)).length,
  };
  if (surface.pluginDir != null) {
    out.plugins = Object.keys(tree).filter((rel) => r.plugin?.test(rel)).length;
  }
  if (surface.hooksFile != null) {
    out.hooks = surface.hooksFile in tree ? 1 : 0;
  }
  return out;
}

export function diffSummary(surface: SurfaceSpec, before: Tree, after: Tree): {
  added: string[];
  removed: string[];
  modified: string[];
  always_on_char_delta: number;
} {
  const b = new Set(Object.keys(before));
  const a = new Set(Object.keys(after));
  const added = [...a].filter((k) => !b.has(k)).sort();
  const removed = [...b].filter((k) => !a.has(k)).sort();
  const modified = [...b]
    .filter((k) => a.has(k) && before[k] !== after[k])
    .sort();
  return {
    added,
    removed,
    modified,
    always_on_char_delta: alwaysOnText(surface, after).length - alwaysOnText(surface, before).length,
  };
}

export function diversity(trees: Record<string, Tree>): {
  n: number;
  n_distinct: number;
  mean_line_jaccard: number;
} {
  const names = Object.keys(trees).sort();
  if (names.length < 2) {
    return { n: names.length, n_distinct: names.length, mean_line_jaccard: 1.0 };
  }
  const lines = (t: Tree): Set<string> => {
    const s = new Set<string>();
    for (const [rel, c] of Object.entries(t)) {
      for (const ln of c.split(/\r?\n/)) {
        if (ln.trim()) s.add(`${rel}:${ln}`);
      }
    }
    return s;
  };
  const sets = Object.fromEntries(names.map((n) => [n, lines(trees[n]!)]));
  const sims: number[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const A = sets[names[i]!]!;
      const B = sets[names[j]!]!;
      const u = new Set([...A, ...B]);
      const inter = [...A].filter((x) => B.has(x)).length;
      sims.push(u.size ? inter / u.size : 1.0);
    }
  }
  const distinct = new Set(
    Object.values(trees).map((t) =>
      JSON.stringify(Object.entries(t).sort(([x], [y]) => x.localeCompare(y))),
    ),
  ).size;
  return {
    n: names.length,
    n_distinct: distinct,
    mean_line_jaccard: Math.round((sims.reduce((a, b) => a + b, 0) / sims.length) * 10000) / 10000,
  };
}
