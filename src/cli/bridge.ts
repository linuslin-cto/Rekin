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

/** Persist a Codex Responses-API bridge endpoint and print .env settings. */

import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as config from "../config.js";

const LITELLM_CONFIG = `model_list:
  - model_name: {model}
    litellm_params:
      model: vertex_ai/{model}
      vertex_project: os.environ/GOOGLE_CLOUD_PROJECT
      vertex_location: os.environ/GOOGLE_CLOUD_LOCATION
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/HARNESS2_BRIDGE_KEY
`;

/** Allocate an ephemeral TCP port (sync; Node's listen(0) is async on Windows). */
export function freePort(host: string): number {
  const script =
    "const n=require('net');const s=n.createServer();s.listen(0," +
    JSON.stringify(host) +
    ",()=>{process.stdout.write(String(s.address().port));s.close()});";
  const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim();
  const port = Number.parseInt(out, 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`freePort failed: ${JSON.stringify(out)}`);
  return port;
}

export function loadOrCreateEndpoint(
  filePath: string,
  opts: { host: string; port?: number },
): { port: number; key: string } {
  let saved: { port?: number; key?: string } = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath, "utf8")) as { port?: number; key?: string };
  } catch {
    /* first run */
  }
  const endpoint = {
    port: opts.port || saved.port || 0,
    key: saved.key || crypto.randomBytes(18).toString("base64url"),
  };
  if (!endpoint.port) endpoint.port = freePort(opts.host);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(endpoint) + "\n", { encoding: "utf8", mode: 0o600 });
  return endpoint as { port: number; key: string };
}

export function bridgeSettings(
  endpoint: { port: number; key: string },
  opts: { model: string; host: string },
): Record<string, string> {
  const settings: Record<string, string> = {
    HARNESS2_CODEX_BASE_URL: `http://127.0.0.1:${endpoint.port}/v1`,
    HARNESS2_CODEX_API_KEY: endpoint.key,
    HARNESS2_CODEX_MODEL: opts.model,
  };
  if (opts.host !== "127.0.0.1") {
    settings.HARNESS2_CODEX_CONTAINER_URL = `http://host.docker.internal:${endpoint.port}/v1`;
  }
  return settings;
}

export function main(argv = process.argv.slice(2)): number {
  let model = config.SOLVER_MODEL_CX || "";
  let host = "127.0.0.1";
  let port = 0;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model" && argv[i + 1]) model = argv[++i]!;
    else if (a === "--host" && argv[i + 1]) host = argv[++i]!;
    else if (a === "--port" && argv[i + 1]) port = Number.parseInt(argv[++i]!, 10);
    else if (a === "--dry-run") dryRun = true;
  }
  if (!model) {
    console.error("rekin-bridge: pass --model or set HARNESS2_CODEX_MODEL / HARNESS2_SOLVER_MODEL");
    return 2;
  }
  if (!config.VERTEX_PROJECT && !dryRun) {
    console.error("Set GOOGLE_CLOUD_PROJECT in .env");
    return 1;
  }

  const root = path.join(config.DEPENDENCIES, "codex");
  const endpointPath = path.join(root, "bridge.json");
  const endpoint = loadOrCreateEndpoint(endpointPath, { host, port });
  const litellmConfig = path.join(root, "bridge.yaml");
  fs.writeFileSync(litellmConfig, LITELLM_CONFIG.replaceAll("{model}", model), "utf8");

  const settings = bridgeSettings(endpoint, { model, host });
  console.log("Add these to .env, then run rekin-setup <bench> --substrate cx:");
  console.log(Object.entries(settings).map(([k, v]) => `${k}=${v}`).join("\n"));

  if (dryRun) return 0;

  const litellm = process.platform === "win32" ? "litellm.cmd" : "litellm";
  const child = spawn(
    litellm,
    ["--config", litellmConfig, "--host", host, "--port", String(endpoint.port)],
    {
      env: {
        ...process.env,
        HARNESS2_BRIDGE_KEY: endpoint.key,
        GOOGLE_CLOUD_PROJECT: config.VERTEX_PROJECT,
        GOOGLE_CLOUD_LOCATION: config.VERTEX_REGION,
      },
      stdio: "inherit",
    },
  );
  child.on("error", (err) => {
    console.error(
      `rekin-bridge: failed to start litellm (${err.message}); install LiteLLM or use --dry-run`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  return 0;
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/cli/bridge.ts") || entry.endsWith("/cli/bridge.js")) {
  process.exitCode = main();
}
