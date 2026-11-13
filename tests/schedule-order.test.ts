import { describe, expect, it } from "vitest";
import {
  defaultReferenceDomainOrder,
  modeToken,
  ns,
  streamOrder,
  validateTag,
} from "../src/core/schedule.js";

describe("schedule naming and order", () => {
  it("modeToken and ns shape", () => {
    expect(modeToken("parallel")).toBe("agg");
    expect(modeToken("sequential")).toBe("seq");
    expect(ns("demo", "oc", "agg", 2)).toBe("demo-oc-agg2");
    expect(ns("demo", "oc", "seq", 1, { seed: 7, tag: "smoke" })).toBe("demo-oc-seq1-s7-smoke");
    expect(() => validateTag("s12")).toThrow(/seed segment/);
  });

  it("streamOrder reference path is stable and filtered", () => {
    const by = {
      accounting: ["ledger-2", "ledger-1"],
      legal: ["a"],
    };
    const ref = defaultReferenceDomainOrder(by);
    expect(ref[0]).toBe("accounting");
    const order = streamOrder(by, null, ref);
    expect(order).toEqual([
      ["accounting", "ledger-1"],
      ["accounting", "ledger-2"],
      ["legal", "a"],
    ]);
    const subset = streamOrder({ accounting: by.accounting }, null, ref);
    expect(subset).toEqual([
      ["accounting", "ledger-1"],
      ["accounting", "ledger-2"],
    ]);
  });

  it("seeded order is deterministic for the same seed", () => {
    const by = { d1: ["t1", "t2", "t3"], d2: ["a", "b"] };
    const a = streamOrder(by, 42, []);
    const b = streamOrder(by, 42, []);
    expect(a).toEqual(b);
    expect(streamOrder(by, 99, [])).not.toEqual(a);
  });
});
