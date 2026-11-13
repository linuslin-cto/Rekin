import { describe, expect, it } from "vitest";
import { providerKeys, scrubEnv, SCRUB_ENV } from "../src/config.js";
import { CodexSubstrate } from "../src/substrate/codex.js";
import { OpencodeSubstrate } from "../src/substrate/opencode.js";

describe("scrubEnv", () => {
  it("drops runner secrets while keeping requested keys", () => {
    const env = scrubEnv(
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-test",
        HARNESS2_JUDGE_API_KEY: "secret",
        SAFE: "1",
      },
      { keep: ["OPENAI_API_KEY"] },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SAFE).toBe("1");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.HARNESS2_JUDGE_API_KEY).toBeUndefined();
    expect(SCRUB_ENV.has("OPENAI_API_KEY")).toBe(true);
  });

  it("scrubs the host secret set used by demos and proposers", () => {
    const host: Record<string, string> = {
      PATH: "/usr/bin",
      HARNESS2_JUDGE_API_KEY: "secret-judge",
      HARNESS2_BRIDGE_KEY: "secret-bridge",
      HARNESS2_CODEX_API_KEY: "secret-codex",
      OPENAI_API_KEY: "sk-judge",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "tok-ant",
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      GITHUB_TOKEN: "ghp_secret",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      AWS_SESSION_TOKEN: "aws_sess",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-tok",
      GOOGLE_API_KEY: "g-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "g-genai-key",
      GOOGLE_APPLICATION_CREDENTIALS: "/adc.json",
      SAFE: "1",
    };
    const scrubbed = scrubEnv(host);
    for (const key of [
      "HARNESS2_JUDGE_API_KEY",
      "HARNESS2_BRIDGE_KEY",
      "HARNESS2_CODEX_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "GITHUB_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
    ]) {
      expect(scrubbed[key]).toBeUndefined();
    }
    expect(scrubbed.GOOGLE_APPLICATION_CREDENTIALS).toBe("/adc.json");
    expect(scrubbed.SAFE).toBe("1");
  });

  it("providerKeys keep only the configured provider", () => {
    const host = {
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      GEMINI_API_KEY: "gm-key",
      GOOGLE_API_KEY: "g-key",
      GOOGLE_GENERATIVE_AI_API_KEY: "g-genai-key",
      AWS_ACCESS_KEY_ID: "AKIA_TEST",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-tok",
      GITHUB_TOKEN: "ghp_secret",
      HARNESS2_JUDGE_API_KEY: "secret-judge",
    };
    const cases: Record<string, Set<string>> = {
      "openai/gpt-test": new Set(["OPENAI_API_KEY"]),
      "anthropic/claude-test": new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]),
      "google/gemini-test": new Set([
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
      ]),
      "amazon-bedrock/claude-test": new Set([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
      ]),
      "google-vertex/gemini-test": new Set(),
    };
    for (const [model, kept] of Object.entries(cases)) {
      const env = scrubEnv(host, { keep: providerKeys(model) });
      expect(new Set(Object.keys(host).filter((k) => k in env))).toEqual(kept);
    }
  });

  it("substrate launchers keep only their provider keys", () => {
    const host = {
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
      GITHUB_TOKEN: "ghp_secret",
      HARNESS2_JUDGE_API_KEY: "secret-judge",
      PATH: "/usr/bin",
    };
    const oc = new OpencodeSubstrate().runEnv(host, "/ws", { model: "anthropic/claude-test" });
    expect(oc.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(oc.ANTHROPIC_BASE_URL).toBe("https://proxy.example/v1");
    expect(oc.OPENAI_API_KEY).toBeUndefined();
    expect(oc.GITHUB_TOKEN).toBeUndefined();
    expect(oc.OPENCODE_PERMISSION).toContain("/ws");

    const cx = new CodexSubstrate().execEnv(host, { codexHome: "/tmp/codex" });
    expect(cx.CODEX_HOME).toBe("/tmp/codex");
    expect(cx.OPENAI_API_KEY).toBeUndefined();
    expect(cx.GITHUB_TOKEN).toBeUndefined();
    expect(cx.OPENAI_BASE_URL).toBeUndefined();
  });
});
