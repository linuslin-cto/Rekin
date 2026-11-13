import { describe, expect, it } from "vitest";
import { modeToken, Namespace, ns, validateTag } from "../src/core/schedule.js";

describe("namespace", () => {
  it("formats seeded and tagged cells", () => {
    expect(ns("demo", "oc", "agg", 2)).toBe("demo-oc-agg2");
    expect(ns("demo", "oc", "agg", 2, { seed: 7 })).toBe("demo-oc-agg2-s7");
    expect(ns("lab", "cx", "seq", 1, { seed: 3, tag: "smoke" })).toBe("lab-cx-seq1-s3-smoke");
    expect(String(new Namespace("demo", "oc", "agg", 1, 7))).toBe("demo-oc-agg1-s7");
  });

  it("rejects seed-like tags and empty substrates", () => {
    expect(() => validateTag("s7")).toThrow(/seed segment/);
    expect(() => ns("demo", "", "agg", 1)).toThrow(/substrate/);
  });

  it("accepts parallel/sequential aliases", () => {
    expect(modeToken("parallel")).toBe("agg");
    expect(modeToken("sequential")).toBe("seq");
  });

  it("builds task dirs with flattened task ids", () => {
    const n = new Namespace("demo", "oc", "agg", 2);
    expect(n.taskDir("/runs", "contracts/task-1").replace(/\\/g, "/")).toBe(
      "/runs/demo-oc-agg2/contracts__task-1",
    );
    expect(n.runId("ledger-1", "agg1")).toBe("demo-oc-agg2/ledger-1/agg1");
  });
});
