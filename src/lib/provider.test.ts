import { describe, expect, it } from "vitest";
import {
  normalizeClientProviderUrl,
  trustedServerProviderUrl,
} from "./provider";

describe("AI provider endpoint safety", () => {
  it("accepts public HTTPS provider endpoints", () => {
    expect(normalizeClientProviderUrl("https://api.example.com/v1", false)).toBe(
      "https://api.example.com/v1",
    );
  });

  it("rejects credentials and private network endpoints in production", () => {
    expect(normalizeClientProviderUrl("https://user:pass@example.com", false)).toBeNull();
    expect(normalizeClientProviderUrl("http://127.0.0.1:11434/v1", false)).toBeNull();
    expect(normalizeClientProviderUrl("https://192.168.1.20/v1", false)).toBeNull();
  });

  it("allows a local HTTP model endpoint during local development", () => {
    expect(normalizeClientProviderUrl("http://localhost:11434/v1", true)).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("normalizes a trusted self-hosted server endpoint", () => {
    expect(trustedServerProviderUrl("https://llm.example.com/v1/")).toBe(
      "https://llm.example.com/v1",
    );
  });
});
