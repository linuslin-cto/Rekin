import { describe, expect, it } from "vitest";
import { BudgetError, Ledger, expectedRollouts, expectedSessions } from "../src/core/ledger.js";

describe("ledger budget identity", () => {
  it("expects R=4k and P=3k", () => {
    expect(expectedRollouts(2)).toBe(8);
    expect(expectedSessions(2)).toBe(6);
  });

  it("asserts identity after recording", () => {
    const ledger = new Ledger("agg", "t1", 1);
    for (const l of ["base1", "inv1", "dom1", "agg1"]) ledger.rollout(l);
    for (const l of ["inv1", "dom1", "agg1"]) ledger.session(l);
    ledger.assertIdentity();
    expect(ledger.toDict().R).toBe(4);
    expect(ledger.toDict().P).toBe(3);
  });

  it("rejects duplicates", () => {
    const ledger = new Ledger("agg", "t1", 1);
    ledger.rollout("base1");
    ledger.rollout("base1");
    expect(() => ledger.assertIdentity()).toThrow(BudgetError);
  });
});
