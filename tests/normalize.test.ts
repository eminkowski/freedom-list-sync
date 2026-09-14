import { describe, expect, it } from "vitest";

import { normalizeDomain, normalizeDomains } from "../src/domains/normalize.js";

describe("normalizeDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomain("  Example.COM  ")).toBe("example.com");
  });

  it("removes trailing dots", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });

  it("rejects localhost and wildcard values", () => {
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("*")).toBeNull();
    expect(normalizeDomain("http://")).toBeNull();
    expect(normalizeDomain("0.0.0.0")).toBeNull();
  });

  it("rejects IP literals", () => {
    expect(normalizeDomain("127.0.0.1")).toBeNull();
    expect(normalizeDomain("::1")).toBeNull();
  });

  it("does not parse URLs unless allowUrl is set", () => {
    expect(normalizeDomain("https://example.com")).toBeNull();
    expect(normalizeDomain("https://example.com", { allowUrl: true })).toBe("example.com");
  });

  it("rejects single-label names", () => {
    expect(normalizeDomain("intranet")).toBeNull();
  });

  it("rejects malformed domains", () => {
    expect(normalizeDomain("-example.com")).toBeNull();
    expect(normalizeDomain("example-.com")).toBeNull();
    expect(normalizeDomain("exam ple.com")).toBeNull();
    expect(normalizeDomain("example")).toBeNull();
    expect(normalizeDomain("example..com")).toBeNull();
    expect(normalizeDomain("*.example.com")).toBeNull();
    expect(normalizeDomain("/example.com/")).toBeNull();
  });

  it("rejects pseudo-domains with non-letter TLDs like example.net2", () => {
    expect(normalizeDomain("example.net2")).toBeNull();
  });

  it("accepts valid probe-style subdomains under example.com", () => {
    expect(normalizeDomain("probe-001.example.com")).toBe("probe-001.example.com");
  });
});

describe("normalizeDomains", () => {
  it("deduplicates and sorts", () => {
    expect(normalizeDomains(["B.com", "a.com", "a.com."])).toEqual(["a.com", "b.com"]);
  });
});
