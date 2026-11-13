import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeSettings, loadOrCreateEndpoint } from "../src/cli/bridge.js";

describe("bridge endpoint", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  it("reuses saved port and key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-bridge-"));
    roots.push(root);
    const file = path.join(root, "bridge.json");
    const first = loadOrCreateEndpoint(file, { host: "127.0.0.1", port: 8765 });
    expect(first.port).toBe(8765);
    expect(first.key.length).toBeGreaterThan(8);
    const second = loadOrCreateEndpoint(file, { host: "127.0.0.1", port: 0 });
    expect(second).toEqual(first);
  });

  it("prints container URL when host is not loopback", () => {
    const settings = bridgeSettings(
      { port: 9, key: "k" },
      { model: "gemini-test", host: "0.0.0.0" },
    );
    expect(settings.HARNESS2_CODEX_CONTAINER_URL).toContain("host.docker.internal:9");
    expect(settings.HARNESS2_CODEX_BASE_URL).toBe("http://127.0.0.1:9/v1");
    expect(settings.HARNESS2_CODEX_API_KEY).toBe("k");
  });

  it("allocates a free port when none is saved", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rekin-bridge-"));
    roots.push(root);
    const file = path.join(root, "bridge.json");
    const endpoint = loadOrCreateEndpoint(file, { host: "127.0.0.1", port: 0 });
    expect(endpoint.port).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).key).toBe(endpoint.key);
  });
});
