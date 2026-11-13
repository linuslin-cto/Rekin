import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { callFingerprint, Proposer } from "../src/core/proposer.js";
import { makeChannelSpec } from "../src/core/spec.js";

describe("proposer call cache", () => {
  it("callFingerprint changes when context file contents change", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-pf-"));
    try {
      const ctx = path.join(root, "context");
      fs.mkdirSync(ctx);
      fs.writeFileSync(path.join(ctx, "task.md"), "v1", "utf8");
      const a = callFingerprint("lbl", "mission", "sys", ctx);
      const b = callFingerprint("lbl", "mission", "sys", ctx);
      expect(a).toBe(b);
      fs.writeFileSync(path.join(ctx, "task.md"), "v2", "utf8");
      expect(callFingerprint("lbl", "mission", "sys", ctx)).not.toBe(a);
      expect(callFingerprint("other", "mission", "sys", ctx)).not.toBe(
        callFingerprint("lbl", "mission", "sys", ctx),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses audit response for identical fingerprints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-pcache-"));
    try {
      const audit = path.join(root, "audit");
      fs.mkdirSync(audit);
      const prop = new Proposer(makeChannelSpec("opencode", "local/cache-fixture"), {
        auditDir: audit,
        attempts: 1,
      });
      const mission = "cached mission";
      const key = callFingerprint("fixture", mission, "", null);
      const safe = `fixture.${key}`;
      fs.writeFileSync(path.join(audit, `${safe}.response.md`), "cached answer", "utf8");
      const reply = prop.call(mission, null, "fixture");
      expect(reply.ok).toBe(true);
      expect(reply.cached).toBe(true);
      expect(reply.text).toBe("cached answer");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
