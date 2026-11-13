import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCODE_SURFACE } from "../src/substrate/opencode.js";
import {
  diffSummary,
  diversity,
  normalizeRel,
  readTree,
  validate,
  writeTree,
} from "../src/core/tree.js";

describe("tree surface", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("rejects path escapes", () => {
    expect(() => normalizeRel("../x")).toThrow(/escapes/);
  });

  it("round-trips write/read and diffs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-tree-"));
    roots.push(root);
    const before = {
      "systemprompt.md": "a\n",
      "guardrails.md": "",
      "LongTermMEMORY.md": "",
      "tool_descriptions/tool_guidance.md": "",
      "scripts/summarize.py": "print(1)\n",
    };
    writeTree(OPENCODE_SURFACE, before, root, { stubs: false });
    const got = readTree(OPENCODE_SURFACE, root);
    expect(got["scripts/summarize.py"]).toBe("print(1)\n");
    const after = { ...got, "scripts/summarize.py": "print(2)\n" };
    const diff = diffSummary(OPENCODE_SURFACE, got, after);
    expect(diff.modified).toEqual(["scripts/summarize.py"]);
    expect(diversity({ a: got, b: after }).n_distinct).toBe(2);
  });

  it("validate rejects broken python scripts", () => {
    expect(() =>
      validate(OPENCODE_SURFACE, {
        "systemprompt.md": "x",
        "guardrails.md": "",
        "LongTermMEMORY.md": "",
        "tool_descriptions/tool_guidance.md": "",
        "scripts/bad.py": "def broken(:\n",
      }),
    ).toThrow(/does not compile/);
  });
});
