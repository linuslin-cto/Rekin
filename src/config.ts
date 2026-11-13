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

/** Deployment settings. Shell values override .env. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(fileURLToPath(import.meta.url));
export const ROOT =
  fs.existsSync(path.join(path.dirname(PKG), "package.json"))
    ? path.dirname(PKG)
    : process.cwd();
export const THIRD_PARTY = path.join(ROOT, "third_party");
export const METHOD_VERSION = 2;
export const DEPENDENCIES = path.join(ROOT, "dependencies");
/** Mutable runtime paths (tests may re-point these). */
export const paths = {
  OPENCODE_DIR: path.join(DEPENDENCIES, "opencode"),
  BUN: path.join(DEPENDENCIES, "tools", "node_modules", ".bin", "bun"),
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadDotenv(dotenvPath: string = path.join(ROOT, ".env")): void {
  let text: string;
  try {
    text = fs.readFileSync(dotenvPath, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    if (!key || !/^[A-Za-z0-9_]+$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    } else if (value.includes(" #")) {
      value = value.split(" #", 1)[0]!.replace(/\s+$/, "");
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv();

export function env(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
}

export function envInt(name: string, defaultValue: number): number {
  const v = env(name);
  if (v === undefined) return defaultValue;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

export function requireEnv(name: string, opts: { neededBy: string }): string {
  const v = env(name);
  if (!v) {
    throw new ConfigError(
      `${name} is required for ${opts.neededBy}; set it in .env or the shell (see .env.example)`,
    );
  }
  return v;
}

export const RUNS = path.resolve(
  path.normalize(env("HARNESS2_RUNS_DIR", path.join(ROOT, "runs"))!),
);
export let VERTEX_PROJECT = env("GOOGLE_CLOUD_PROJECT", env("HARNESS2_VERTEX_PROJECT", "")) ?? "";
export const VERTEX_REGION = env("GOOGLE_CLOUD_LOCATION", "global") ?? "global";
if (VERTEX_PROJECT) process.env.GOOGLE_CLOUD_PROJECT ??= VERTEX_PROJECT;
process.env.GOOGLE_CLOUD_LOCATION ??= VERTEX_REGION;

export const SOLVER_MODEL_OC = env("HARNESS2_SOLVER_MODEL", "") ?? "";
export const SOLVER_MODEL_CX =
  env("HARNESS2_CODEX_MODEL", SOLVER_MODEL_OC.split("/", 2).pop()) ?? "";
export const IMPROVER_MODEL = env("HARNESS2_IMPROVER_MODEL", SOLVER_MODEL_OC) ?? "";
export const JUDGE_MODEL = env("HARNESS2_JUDGE_MODEL", "") ?? "";

export const DEFAULT_PROPOSER_CHANNEL = "opencode";
export const PROPOSER_MODEL_BY_CHANNEL: Record<string, string> = {
  opencode: IMPROVER_MODEL,
  claude_cli: IMPROVER_MODEL,
};
export const PHASE_WIDTH = 2;
export const TRANSPORT_ATTEMPTS = 2;
export const PROPOSER_CONCURRENCY = 2;

export const SCRUB_ENV = new Set([
  "HARNESS2_JUDGE_API_KEY",
  "HARNESS2_BRIDGE_KEY",
  "HARNESS2_CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_WEBHOOK_URL",
  "JIRA_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

export function scrubEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> | null = null,
  opts: { keep?: Iterable<string> } = {},
): Record<string, string> {
  const src = baseEnv ?? process.env;
  const keep = new Set(opts.keep ?? []);
  const drop = new Set([...SCRUB_ENV].filter((k) => !keep.has(k)));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null || drop.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const PROVIDER_KEYS: Record<string, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  "amazon-bedrock": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
  ],
};

export function providerKeys(model: string): readonly string[] {
  return PROVIDER_KEYS[model.split("/", 1)[0]!] ?? [];
}

export function validateModels(opts: { judge?: boolean } = {}): void {
  requireEnv("HARNESS2_SOLVER_MODEL", { neededBy: "executor rollouts" });
  if (!SOLVER_MODEL_OC.includes("/") || !IMPROVER_MODEL.includes("/")) {
    throw new ConfigError("Executor and improver models must use OpenCode's provider/model syntax");
  }
  if ([SOLVER_MODEL_OC, IMPROVER_MODEL].some((m) => m.startsWith("google-vertex"))) {
    if (!VERTEX_PROJECT) throw new ConfigError("Set GOOGLE_CLOUD_PROJECT for Vertex AI");
  }
  if (opts.judge) requireEnv("HARNESS2_JUDGE_MODEL", { neededBy: "benchmark judging" });
}
