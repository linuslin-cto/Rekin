#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pyPath = path.resolve(__dirname, "../../harness2/harness2/core/prompts.py");
const outPath = path.resolve(__dirname, "../src/core/prompts.ts");
const py = fs.readFileSync(pyPath, "utf8");

function extractTriple(pyText, name) {
  const re = new RegExp(`^${name}\\s*=\\s*(?:\\(\\s*)?"""([\\s\\S]*?)"""(?:\\s*\\))?`, "m");
  const m = pyText.match(re);
  if (m) return m[1];
  const reParen = new RegExp(
    `^${name}\\s*=\\s*\\(\\s*\\n(?:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*\\n)+\\s*\\)`,
    "m",
  );
  const m2 = pyText.match(reParen);
  if (!m2) return null;
  const chunk = m2[0];
  const strings = [...chunk.matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map((x) =>
    x[1].replace(/\\n/g, "\n"),
  );
  return strings.join("");
}

const constNames = [
  "ANSWER_FREE",
  "ANSWER_FREE_SELECT",
  "EVIDENCE_BOUNDARY",
  "EVIDENCE_BOUNDARY_SELECT",
  "POOL_MIXED_SELECT",
  "POOL_FINALS_SELECT",
  "_SURFACE_OPENCODE",
  "_SURFACE_CODEX",
  "GENERALIZE",
  "_KEEP_BASE",
  "_INV_TEMPLATE",
  "_DOM_TEMPLATE",
  "_TTS_SURFACE_HEAD_OPENCODE",
  "_TTS_SURFACE_HEAD_CODEX",
  "_TTS_INV",
  "_TTS_DOM",
  "_TTS_GENERALIZE",
  "_TTS_HOW",
];

function toTemplate(body) {
  return (
    "`" +
    body
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${") +
    "`"
  );
}

let out = `// Copyright 2026 Google LLC
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

/** Ported from harness2/core/prompts.py (string blocks + structure; see scripts/gen-prompts.mjs). */

import type { BenchPrompts } from "./spec.js";
import type { SurfaceSpec } from "./tree.js";

export const PROMPTS_VERSION = "harness2-1";
export const VERSION = PROMPTS_VERSION;

`;

for (const name of constNames) {
  const body = extractTriple(py, name);
  if (body == null) {
    out += `// TODO(prompts.py): missing ${name}\nconst ${name} = "";\n\n`;
  } else {
    out += `const ${name} = ${toTemplate(body)};\n\n`;
  }
}

out += fs.readFileSync(path.resolve(__dirname, "gen-prompts-tail.ts.txt"), "utf8");
fs.writeFileSync(outPath, out, "utf8");
console.log("Wrote", outPath, out.length);
