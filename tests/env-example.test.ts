import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/config.js";

describe(".env.example", () => {
  it("documents the required model keys", () => {
    const example = path.join(ROOT, ".env.example");
    expect(fs.existsSync(example)).toBe(true);
    const text = fs.readFileSync(example, "utf8");
    for (const key of [
      "GOOGLE_CLOUD_PROJECT",
      "HARNESS2_SOLVER_MODEL",
      "HARNESS2_JUDGE_MODEL",
      "HARNESS2_IMPROVER_MODEL",
      "HARNESS2_RUNS_DIR",
    ]) {
      expect(text).toContain(`${key}=`);
    }
  });

  it("loadDotenv fills only unset keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-dotenv-"));
    try {
      const file = path.join(dir, ".env");
      fs.writeFileSync(file, "REKIN_TEST_DOTENV=from-file\n", "utf8");
      delete process.env.REKIN_TEST_DOTENV;
      const { loadDotenv } = await import("../src/config.js");
      loadDotenv(file);
      expect(process.env.REKIN_TEST_DOTENV).toBe("from-file");
      process.env.REKIN_TEST_DOTENV = "from-shell";
      fs.writeFileSync(file, "REKIN_TEST_DOTENV=from-file-again\n", "utf8");
      loadDotenv(file);
      expect(process.env.REKIN_TEST_DOTENV).toBe("from-shell");
    } finally {
      delete process.env.REKIN_TEST_DOTENV;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
