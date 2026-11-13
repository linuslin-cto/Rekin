import { describe, expect, it } from "vitest";
import * as prompts from "../src/core/prompts.js";
import { makeBenchPrompts } from "../src/core/spec.js";

describe("prompts pool blocks", () => {
  it("includes anonymous-candidate guidance for select", () => {
    const bp = makeBenchPrompts({ work: "demo work" });
    const mixed = prompts.select(bp, 3, { poolKind: "mixed" });
    const finals = prompts.select(bp, 3, { poolKind: "finals" });
    expect(mixed).toContain("THE CANDIDATES ARE ANONYMOUS ON PURPOSE");
    expect(mixed).toContain("UNMODIFIED HARNESS");
    expect(finals).toContain("THE CANDIDATES ARE ANONYMOUS ON PURPOSE");
    expect(finals).not.toContain("UNMODIFIED HARNESS");
  });
});
