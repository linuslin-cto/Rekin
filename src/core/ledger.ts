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

/** Budget accounting: R = 4k rollouts and P = 3k improvement stages. */

export function expectedRollouts(k: number): number {
  return 4 * Math.trunc(k);
}

export function expectedSessions(k: number): number {
  return 3 * Math.trunc(k);
}

export class BudgetError extends Error {
  override name = "BudgetError";
}

export interface Entry {
  kind: string;
  label: string;
  usd: number;
  cached: boolean;
  attempts: number;
}

export class Ledger {
  mode: string;
  taskId: string;
  k: number;
  entries: Entry[] = [];

  constructor(mode: string, taskId: string, k: number) {
    this.mode = mode;
    this.taskId = taskId;
    this.k = k;
  }

  rollout(label: string, usd = 0.0, opts: { cached?: boolean } = {}): void {
    this.entries.push({
      kind: "rollout",
      label,
      usd,
      cached: opts.cached ?? false,
      attempts: 1,
    });
  }

  session(
    label: string,
    usd = 0.0,
    opts: { cached?: boolean; attempts?: number } = {},
  ): void {
    this.entries.push({
      kind: "session",
      label,
      usd,
      cached: opts.cached ?? false,
      attempts: opts.attempts ?? 1,
    });
  }

  get R(): number {
    return this.entries.filter((e) => e.kind === "rollout").length;
  }

  get P(): number {
    return this.entries.filter((e) => e.kind === "session").length;
  }

  get usd(): number {
    return Math.round(this.entries.reduce((s, e) => s + e.usd, 0) * 1e6) / 1e6;
  }

  get rolloutUsd(): number {
    return (
      Math.round(
        this.entries.filter((e) => e.kind === "rollout").reduce((s, e) => s + e.usd, 0) * 1e6,
      ) / 1e6
    );
  }

  get sessionUsd(): number {
    return (
      Math.round(
        this.entries.filter((e) => e.kind === "session").reduce((s, e) => s + e.usd, 0) * 1e6,
      ) / 1e6
    );
  }

  labels(kind: string): string[] {
    return this.entries.filter((e) => e.kind === kind).map((e) => e.label);
  }

  assertIdentity(): void {
    const wantR = expectedRollouts(this.k);
    const wantP = expectedSessions(this.k);
    const rl = this.labels("rollout");
    const sl = this.labels("session");
    const dupes = [
      ...new Set([
        ...rl.filter((label) => rl.filter((x) => x === label).length > 1),
        ...sl.filter((label) => sl.filter((x) => x === label).length > 1),
      ]),
    ].sort();
    if (!dupes.length && this.R === wantR && this.P === wantP) return;
    const detail = [
      `${this.mode}-${this.k} ${this.taskId}: R=${this.R} (want ${wantR}), P=${this.P} (want ${wantP})`,
      `  rollouts: ${this.labels("rollout").join(", ") || "(none)"}`,
      `  sessions: ${this.labels("session").join(", ") || "(none)"}`,
    ];
    if (dupes.length) {
      detail.push(
        `  DUPLICATE labels: ${dupes} -- a repeated label means two stages wrote the same run id and one silently overwrote the other, so a candidate the ledger counts was never actually produced`,
      );
    }
    throw new BudgetError(detail.join("\n"));
  }

  toDict(): Record<string, unknown> {
    return {
      mode: this.mode,
      task_id: this.taskId,
      k: this.k,
      R: this.R,
      expected_R: expectedRollouts(this.k),
      P: this.P,
      session_attempts: this.entries
        .filter((e) => e.kind === "session")
        .reduce((s, e) => s + e.attempts, 0),
      expected_P: expectedSessions(this.k),
      usd: this.usd,
      rollout_usd: this.rolloutUsd,
      session_usd: this.sessionUsd,
      rollouts: this.labels("rollout"),
      sessions: this.labels("session"),
    };
  }
}
