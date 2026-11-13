import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoLeakPaths,
  assertTreeHasNoGraderVerdicts,
} from "../src/core/context.js";

describe("context leak guards", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("rejects answer-key paths via fnmatch", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-ctx-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "nested", "reference_answer.txt"), "secret", "utf8");
    expect(() => assertNoLeakPaths(root, ["reference_answer.txt"])).toThrow(
      /answer-key path/,
    );
  });

  it("rejects grader markers in trees", () => {
    expect(() =>
      assertTreeHasNoGraderVerdicts({ "notes.md": 'score {"pass_rate": 1}' }),
    ).toThrow();
  });
});
