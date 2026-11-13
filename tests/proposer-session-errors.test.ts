import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as config from "../src/config.js";
import { Proposer, ProposerError } from "../src/core/proposer.js";
import { makeChannelSpec } from "../src/core/spec.js";

const originals = { bun: config.paths.BUN, oc: config.paths.OPENCODE_DIR };

afterEach(() => {
  config.paths.BUN = originals.bun;
  config.paths.OPENCODE_DIR = originals.oc;
});

describe("proposer session errors", () => {
  it.each([false, true])(
    "rejects partial output and preserves cost (answer_file=%s)",
    (answerFile) => {
      runSession({ answerFile, fail: true });
    },
  );

  it.each([false, true])(
    "successful file and stdout answers remain usable (answer_file=%s)",
    (answerFile) => {
      runSession({ answerFile, fail: false });
    },
  );
});

function runSession(opts: { answerFile: boolean; fail: boolean }): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-prop-sess-"));
  try {
    const entry = path.join(root, "opencode", "packages", "opencode", "src", "index.ts");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");

    const events: unknown[] = [
      { type: "text", part: { type: "text", text: "partial or final answer" } },
      { type: "step_finish", part: { type: "step-finish", cost: 0.25 } },
    ];
    if (opts.fail) {
      events.push({
        type: "error",
        error: { name: "APIError", data: { message: "provider unavailable" } },
      });
    }

    const standin = path.join(root, "protocol-standin.mjs");
    const lines = events.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(
      standin,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        opts.answerFile
          ? "fs.mkdirSync(path.join(process.cwd(), 'output'), { recursive: true });"
          : "",
        opts.answerFile
          ? "fs.writeFileSync(path.join(process.cwd(), 'output', 'answer.md'), 'partial or final answer');"
          : "",
        `process.stdout.write(${JSON.stringify(lines + "\n")});`,
      ]
        .filter(Boolean)
        .join("\n"),
      "utf8",
    );

    const audit = path.join(root, "audit");
    config.paths.BUN = standin;
    config.paths.OPENCODE_DIR = path.join(root, "opencode");
    const proposer = new Proposer(makeChannelSpec("opencode", "local/protocol-fixture"), {
      auditDir: audit,
      attempts: 1,
    });

    if (opts.fail) {
      let caught: ProposerError | null = null;
      try {
        proposer.call("Read the local protocol fixture", null, "fixture");
      } catch (e) {
        caught = e as ProposerError;
      }
      expect(caught).toBeInstanceOf(ProposerError);
      expect(String(caught!.message)).toContain("provider unavailable");
      expect(caught!.costUsd).toBe(0.25);
      const last = proposer.calls[proposer.calls.length - 1]!;
      expect(last.ok).toBe(false);
      expect(last.text).toBe("");
      expect(last.costUsd).toBe(0.25);
      const responses = fs.existsSync(audit)
        ? fs.readdirSync(audit).filter((n) => n.endsWith(".response.md"))
        : [];
      for (const name of responses) {
        expect(fs.readFileSync(path.join(audit, name), "utf8").trim()).toBe("");
      }
    } else {
      const reply = proposer.call("Read the local protocol fixture", null, "fixture");
      expect(reply.ok).toBe(true);
      expect(reply.text).toBe("partial or final answer");
      expect(reply.costUsd).toBe(0.25);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
