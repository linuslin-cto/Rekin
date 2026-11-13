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

/** Improver sessions with file access in an isolated context workspace. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as config from "../config.js";
import type { ChannelSpec } from "./spec.js";

export class ProposerError extends Error {
  attempts: number;
  costUsd: number;
  override name = "ProposerError";

  constructor(message: string, opts: { attempts?: number; costUsd?: number } = {}) {
    super(message);
    this.attempts = opts.attempts ?? 0;
    this.costUsd = opts.costUsd ?? 0;
  }
}

export interface Reply {
  label: string;
  text: string;
  ok: boolean;
  costUsd?: number;
  wallS?: number;
  attempts?: number;
  cached?: boolean;
  channel?: string;
  error?: string;
  audit?: string | null;
  workspace?: string | null;
}

export interface CallOptions {
  system?: string;
  timeout?: number | null;
  maxAttempts?: number | null;
  harvest?: string | null;
}

export class Proposer {
  spec: ChannelSpec;
  auditDir: string | null;
  attempts: number;
  project: string;
  region: string;
  protected _calls: Reply[] = [];

  get calls(): readonly Reply[] {
    return this._calls;
  }

  constructor(
    spec: ChannelSpec,
    opts: {
      auditDir?: string | null;
      attempts?: number;
      project?: string;
      region?: string;
    } = {},
  ) {
    this.spec = spec;
    this.auditDir = opts.auditDir ?? null;
    this.attempts = opts.attempts ?? 2;
    this.project = opts.project ?? config.VERTEX_PROJECT;
    this.region = opts.region ?? config.VERTEX_REGION;
    if (!this.spec.model.trim()) {
      throw new Error("Set HARNESS2_IMPROVER_MODEL before starting model sessions");
    }
  }

  env(): Record<string, string> {
    const keep =
      this.spec.kind === "claude_cli" ? ([] as string[]) : [...config.providerKeys(this.spec.model)];
    const e = config.scrubEnv(process.env, { keep });
    if (this.spec.kind === "claude_cli") {
      Object.assign(e, {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: this.project,
        CLOUD_ML_REGION: this.region,
        ANTHROPIC_MODEL: this.spec.model,
      });
    } else {
      Object.assign(e, {
        GOOGLE_VERTEX_PROJECT: this.project,
        GOOGLE_VERTEX_LOCATION: this.region,
        VERTEXAI_LOCATION: this.region,
      });
    }
    return e;
  }

  call(
    mission: string,
    contextDir: string | null,
    label: string,
    opts: CallOptions = {},
  ): Reply {
    const cacheKey = callFingerprint(label, mission, opts.system ?? "", contextDir);
    const cached = this.cached(label, cacheKey, Boolean(opts.harvest));
    if (cached) {
      this._calls.push(cached);
      return cached;
    }

    const wall = opts.timeout ?? this.spec.timeout ?? 3600;
    const tries = Math.max(1, opts.maxAttempts ?? this.attempts);
    let last = "";
    let spentUsd = 0;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) {
        const deadline = Date.now() + 10_000 * (attempt - 1);
        while (Date.now() < deadline) {
          /* backoff */
        }
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-prop-"));
      try {
        if (contextDir && fs.existsSync(contextDir) && fs.statSync(contextDir).isDirectory()) {
          fs.cpSync(contextDir, path.join(tmp, "context"), { recursive: true });
        }
        const runner =
          this.spec.kind === "claude_cli"
            ? () => this.claudeCli(tmp, mission, opts.system ?? "", wall)
            : () => this.opencode(tmp, mission, opts.system ?? "", wall);
        const [text, cost, err] = runner();
        spentUsd += cost;
        if (!text.trim()) {
          last = err || "empty reply";
          continue;
        }
        const r: Reply = {
          label,
          text,
          ok: true,
          costUsd: spentUsd,
          wallS: Math.round((Date.now() - t0) / 100) / 10,
          attempts: attempt,
          channel: this.spec.kind,
        };
        if (opts.harvest) {
          r.workspace = this.harvest(tmp, opts.harvest, label, cacheKey);
          if (!r.workspace) this.dropWorkspace(this.paths(label, cacheKey));
        }
        this.writeAudit(r, mission, opts.system ?? "", cacheKey);
        this._calls.push(r);
        return r;
      } catch (e) {
        last = `${e instanceof Error ? e.name : "Error"}: ${e}`;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    const fail: Reply = {
      label,
      text: "",
      ok: false,
      wallS: Math.round((Date.now() - t0) / 100) / 10,
      attempts: tries,
      channel: this.spec.kind,
      error: last,
      costUsd: spentUsd,
    };
    this._calls.push(fail);
    this.writeAudit(fail, mission, opts.system ?? "", cacheKey);
    throw new ProposerError(`[${label}] ${this.spec.kind}/${this.spec.model}: ${last}`, {
      attempts: tries,
      costUsd: spentUsd,
    });
  }

  protected claudeCli(
    cwd: string,
    mission: string,
    system: string,
    wall: number,
  ): [string, number, string] {
    const cli = process.platform === "win32" ? "claude.cmd" : "claude";
    const cmd = [
      cli,
      "--dangerously-skip-permissions",
      "-p",
      "--output-format",
      "json",
      "--effort",
      this.spec.effort ?? "high",
    ];
    let stdin = mission;
    if (system) {
      if (system.length > 120_000) {
        stdin = `# SYSTEM INSTRUCTIONS\n\n${system}\n\n# END\n\n${mission}`;
        cmd.push(
          "--append-system-prompt",
          "Follow the SYSTEM INSTRUCTIONS block at the top of the message.",
        );
      } else {
        cmd.push("--append-system-prompt", system);
      }
    }
    const p = spawnSync(cmd[0]!, cmd.slice(1), {
      input: stdin,
      cwd,
      env: this.env(),
      encoding: "utf8",
      timeout: wall * 1000,
    });
    const payload = parseJson(p.stdout ?? "");
    let text = String(payload.result ?? payload.text ?? "");
    let err = "";
    if (payload.is_error || (payload.subtype != null && payload.subtype !== "success")) {
      err = `CLI error: ${payload.subtype} ${text.slice(0, 200)}`;
      text = "";
    } else if (p.status !== 0 && !text.trim()) {
      err = `rc=${p.status}: ${(p.stderr ?? "").slice(-300)}`;
    }
    return [text, Number(payload.total_cost_usd ?? 0), err];
  }

  protected opencode(
    cwd: string,
    mission: string,
    system: string,
    wall: number,
  ): [string, number, string] {
      const oc = requireOpencodeDir();
    const out = path.join(cwd, "output");
    fs.mkdirSync(out, { recursive: true });
    if (system) fs.writeFileSync(path.join(cwd, "SYSTEM.md"), system, "utf8");
    fs.writeFileSync(path.join(cwd, "MISSION.md"), mission, "utf8");
    fs.writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({ agent: { build: { steps: this.spec.steps } } }),
      "utf8",
    );
    const prompt =
      "Read MISSION.md first. Do what it asks. Reply with the requested output as " +
      "your final message AND save it verbatim to output/answer.md.";
    const env = this.env();
    env.OPENCODE_PERMISSION = JSON.stringify({
      external_directory: { "*": "deny", [cwd]: "allow", [`${cwd}/**`]: "allow" },
    });
    env.XDG_DATA_HOME = path.join(cwd, ".ocdata");
    env.XDG_STATE_HOME = path.join(cwd, ".ocstate");
    const bunArgs = [
      "run",
      "--cwd",
      path.join(oc, "packages", "opencode"),
      "--conditions=browser",
      "src/index.ts",
      "run",
      prompt,
      "--dir",
      cwd,
      "--model",
      this.spec.model,
      "--format",
      "json",
    ];
    if (this.spec.effort) bunArgs.push("--variant", this.spec.effort);
    const { cmd, args } = resolveBun(bunArgs);
    const p = spawnSync(cmd, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: wall * 1000,
    });
    const stdout = p.stdout ?? "";
    const cost = opencodeCost(stdout);
    const [text, err] = opencodeStdout(stdout);
    if (err) return ["", cost, err];
    const ans = path.join(out, "answer.md");
    if (fs.existsSync(ans) && fs.readFileSync(ans, "utf8").trim()) {
      return [fs.readFileSync(ans, "utf8"), cost, ""];
    }
    if (text.trim()) return [text, cost, ""];
    const tail = stripOcBanner(p.stderr ?? "").trim().slice(-300);
    return ["", cost, `rc=${p.status}: ${err || tail || "empty reply"}`];
  }

  protected harvest(tmp: string, sub: string, label: string, cacheKey = ""): string | null {
    const src = path.join(tmp, sub);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return null;
    const dest = this.auditDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "harness2-harvest-"));
    let safe = label.replace(/[^A-Za-z0-9_.-]+/g, "_");
    if (cacheKey) safe = `${safe}.${cacheKey}`;
    const out = path.join(dest, `${safe}.workspace`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.cpSync(src, out, { recursive: true });
    return out;
  }

  protected paths(label: string, cacheKey = ""): Record<string, string> | null {
    if (!this.auditDir) return null;
    fs.mkdirSync(this.auditDir, { recursive: true });
    let safe = label.replace(/[^A-Za-z0-9_.-]+/g, "_");
    if (cacheKey) safe = `${safe}.${cacheKey}`;
    const d = this.auditDir;
    return {
      mission: path.join(d, `${safe}.mission.md`),
      system: path.join(d, `${safe}.system.md`),
      response: path.join(d, `${safe}.response.md`),
      meta: path.join(d, `${safe}.meta.json`),
      workspace: path.join(d, `${safe}.workspace`),
    };
  }

  protected cached(label: string, cacheKey = "", requireWorkspace = false): Reply | null {
    const p = this.paths(label, cacheKey);
    if (!p || !fs.existsSync(p.response)) return null;
    if (requireWorkspace && !fs.existsSync(p.workspace)) return null;
    const txt = fs.readFileSync(p.response, "utf8");
    if (!txt.trim()) return null;
    return {
      label,
      text: txt,
      ok: true,
      costUsd: 0,
      cached: true,
      channel: this.spec.kind,
      audit: p.response,
      workspace: fs.existsSync(p.workspace) ? p.workspace : null,
    };
  }

  protected writeAudit(r: Reply, mission: string, system: string, cacheKey = ""): void {
    const p = this.paths(r.label, cacheKey);
    if (!p) return;
    fs.writeFileSync(p.mission, mission, "utf8");
    if (system) fs.writeFileSync(p.system, system, "utf8");
    fs.writeFileSync(p.response, r.text, "utf8");
    fs.writeFileSync(
      p.meta,
      JSON.stringify(
        {
          label: r.label,
          ok: r.ok,
          channel: r.channel,
          model: this.spec.model,
          effort: this.spec.effort,
          attempts: r.attempts,
          wall_s: r.wallS,
          cost_usd: r.costUsd,
          error: r.error,
        },
        null,
        2,
      ),
      "utf8",
    );
    r.audit = p.response;
  }

  protected dropWorkspace(paths: Record<string, string> | null): void {
    if (paths?.workspace) fs.rmSync(paths.workspace, { recursive: true, force: true });
  }
}

function parseJson(stdout: string): Record<string, unknown> {
  const s = (stdout ?? "").trim();
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(s.slice(i, j + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
  }
  return { result: s };
}

function obj(d: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = d[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function requireOpencodeDir(): string {
  const oc = config.paths.OPENCODE_DIR;
  const entry = path.join(oc, "packages", "opencode", "src", "index.ts");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `no OpenCode checkout at ${oc} (config.paths.OPENCODE_DIR); run setup or point OPENCODE_DIR at a checkout`,
    );
  }
  return oc;
}

function resolveBun(args: string[]): { cmd: string; args: string[] } {
  const bun = config.paths.BUN;
  if (/\.(m?js|cjs)$/i.test(bun)) return { cmd: process.execPath, args: [bun, ...args] };
  if (/\.py$/i.test(bun)) return { cmd: process.platform === "win32" ? "python" : "python3", args: [bun, ...args] };
  return { cmd: bun, args };
}

export function opencodeStdout(stdout: string): [string, string] {
  const texts: string[] = [];
  const errors: string[] = [];
  let sawJson = false;
  for (const raw of (stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawJson = true;
    const part = obj(ev, "part");
    const ptype = String(part.type ?? ev.type ?? "");
    if (ptype === "text") {
      const t = part.text;
      if (typeof t === "string" && t.trim()) texts.push(t);
    } else if (ptype === "error") {
      const e = ev.error;
      let msg = "";
      if (e && typeof e === "object" && !Array.isArray(e)) {
        const ed = e as Record<string, unknown>;
        const data = obj(ed, "data");
        msg = String(data.message ?? ed.name ?? "").trim();
      } else {
        msg = String(e ?? "").trim();
      }
      if (msg) errors.push(msg);
    }
  }
  if (!sawJson) return [stripOcBanner(stdout).trim(), ""];
  return [texts.join("\n\n"), errors.join("; ").slice(-300)];
}

export function opencodeCost(stdout: string): number {
  let total = 0;
  for (const raw of (stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = obj(ev, "part");
    const ptype = String(part.type ?? ev.type ?? "");
    if (ptype === "step-finish" || ptype === "step_finish") {
      const c = part.cost;
      if (typeof c === "number") total += c;
    }
  }
  return Math.round(total * 1e6) / 1e6;
}

function stripOcBanner(stderr: string): string {
  return (stderr || "")
    .split(/\r?\n/)
    .filter((ln) => !/opencode|bun|vite/i.test(ln) || ln.trim().startsWith("{"))
    .join("\n");
}

export function callFingerprint(
  label: string,
  mission: string,
  system: string,
  contextDir: string | null,
): string {
  const h = crypto.createHash("sha256");
  for (const value of [label, mission, system]) {
    h.update(Buffer.from(value, "utf8"));
    h.update("\0");
  }
  if (contextDir) {
    const root = path.resolve(contextDir);
    h.update(Buffer.from(root, "utf8"));
    h.update("\0");
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      const stack = [root];
      const files: string[] = [];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) {
            if (ent.name === "__pycache__" || ent.name === "node_modules") continue;
            stack.push(full);
          } else if (ent.isFile()) files.push(full);
        }
      }
      files.sort();
      for (const p of files) {
        const rel = path.relative(root, p).split(path.sep).join("/");
        h.update(Buffer.from(rel, "utf8"));
        h.update("\0");
        try {
          h.update(fs.readFileSync(p));
        } catch (e) {
          h.update(Buffer.from(`<unreadable:${e}>`));
        }
        h.update("\0");
      }
    }
  }
  return h.digest("hex").slice(0, 16);
}
