import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fingerprint,
  inputsFingerprint,
  isComplete,
  markComplete,
  whyNot,
} from "../src/core/runmark.js";

describe("inputs fingerprint", () => {
  let root: string;
  let files: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-rm-"));
    files = path.join(root, "documents");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "source.txt"), "version-one", "utf8");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is stable for unchanged inputs", () => {
    const first = inputsFingerprint("Use version one.", files);
    const second = inputsFingerprint("Use version one.", files);
    expect(first).toBe(second);
  });

  it("follows the prompt", () => {
    expect(inputsFingerprint("Use version one.", files)).not.toBe(
      inputsFingerprint("Use version two.", files),
    );
  });

  it("follows file contents and membership", () => {
    const before = inputsFingerprint("Use version one.", files);
    fs.writeFileSync(path.join(files, "source.txt"), "version-two", "utf8");
    const changed = inputsFingerprint("Use version one.", files);
    expect(before).not.toBe(changed);
    fs.writeFileSync(path.join(files, "extra.txt"), "more", "utf8");
    expect(changed).not.toBe(inputsFingerprint("Use version one.", files));
  });

  it("ignores byproducts and missing material", () => {
    const before = inputsFingerprint("Use version one.", files);
    fs.mkdirSync(path.join(files, "__pycache__"));
    fs.writeFileSync(path.join(files, "__pycache__", "stale.pyc"), Buffer.from([0]));
    expect(inputsFingerprint("Use version one.", files)).toBe(before);
    expect(inputsFingerprint("Use version one.", null)).toBe(
      inputsFingerprint("Use version one.", path.join(root, "absent")),
    );
  });
});

describe("completion marker", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "h2-mark-")), "run");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
  });

  it("refuses reuse under changed inputs", () => {
    markComplete(runDir, { runId: "r1", inputs: "aaaa" });
    expect(isComplete(runDir, { inputs: "aaaa", matchHarness: false })).toBe(true);
    expect(isComplete(runDir, { inputs: "bbbb", matchHarness: false })).toBe(false);
    expect(whyNot(runDir, { inputs: "aaaa" })).toBe("reusable");
    expect(whyNot(runDir, { inputs: "bbbb" })).toContain("task inputs aaaa != bbbb");
  });

  it("fingerprints harness trees", () => {
    const harness = path.join(path.dirname(runDir), "harness");
    fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(harness, "AGENTS.md"), "a", "utf8");
    expect(fingerprint(null)).toBe("base");
    expect(fingerprint(harness)).toHaveLength(16);
  });
});
