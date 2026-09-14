import { describe, expect, it } from "vitest";

import {
  FreedomAuthenticationError,
  FreedomHttpError,
  FreedomValidationError,
} from "../src/freedom/errors.js";
import {
  buildAddDomainsPayload,
  HttpFreedomWriter,
  interpretPatchResponse,
  isRetryableWriterError,
  prepareDomainsForWrite,
  type FreedomApiRequest,
  type FreedomApiResponse,
} from "../src/freedom/http-writer.js";

function mockResponse(input: {
  status: number;
  ok?: boolean;
  body?: string;
  contentType?: string;
}): FreedomApiResponse {
  return {
    status: () => input.status,
    ok: () => input.ok ?? (input.status >= 200 && input.status < 300),
    headers: () => ({
      "content-type": input.contentType ?? "application/json; charset=utf-8",
    }),
    text: async () => input.body ?? "",
  };
}

describe("buildAddDomainsPayload", () => {
  it("builds the observed Freedom PATCH body", () => {
    expect(buildAddDomainsPayload(["a.com", "b.com"])).toEqual({
      custom_domains_to_add: ["a.com", "b.com"],
    });
  });
});

describe("prepareDomainsForWrite", () => {
  it("deduplicates while preserving order", () => {
    expect(prepareDomainsForWrite(["a.com", "a.com", "b.com"])).toEqual(["a.com", "b.com"]);
  });

  it("rejects empty batches", () => {
    expect(() => prepareDomainsForWrite([])).toThrow(FreedomValidationError);
  });

  it("rejects non-normalized domains", () => {
    expect(() => prepareDomainsForWrite(["Example.COM"])).toThrow(/non-normalized/i);
  });
});

describe("interpretPatchResponse", () => {
  it("maps 401/403 to authentication errors", async () => {
    await expect(
      interpretPatchResponse(1, 1, mockResponse({ status: 401, ok: false, body: "nope" })),
    ).rejects.toBeInstanceOf(FreedomAuthenticationError);

    await expect(
      interpretPatchResponse(1, 1, mockResponse({ status: 403, ok: false, body: "nope" })),
    ).rejects.toBeInstanceOf(FreedomAuthenticationError);
  });

  it("maps 400 to validation error without retry", async () => {
    await expect(
      interpretPatchResponse(1, 1, mockResponse({ status: 400, ok: false, body: "bad request" })),
    ).rejects.toBeInstanceOf(FreedomValidationError);
  });

  it("maps 429/500 to retryable http errors", async () => {
    await expect(
      interpretPatchResponse(1, 1, mockResponse({ status: 429, ok: false, body: "slow down" })),
    ).rejects.toMatchObject({ status: 429 });

    await expect(
      interpretPatchResponse(1, 1, mockResponse({ status: 500, ok: false, body: "boom" })),
    ).rejects.toMatchObject({ status: 500 });

    expect(isRetryableWriterError(new FreedomHttpError(429))).toBe(true);
    expect(isRetryableWriterError(new FreedomHttpError(500))).toBe(true);
    expect(isRetryableWriterError(new FreedomValidationError("no"))).toBe(false);
    expect(isRetryableWriterError(new FreedomAuthenticationError())).toBe(false);
  });

  it("parses successful responses and count deltas", async () => {
    const result = await interpretPatchResponse(
      6618658,
      2,
      mockResponse({
        status: 200,
        body: JSON.stringify({
          id: 6618658,
          name: "Social Media",
          count_websites: 12,
          custom_filters: [],
        }),
      }),
      10,
    );

    expect(result).toEqual({
      requested: 2,
      countBefore: 10,
      countAfter: 12,
      addedCount: 2,
    });
  });
});

describe("HttpFreedomWriter retries", () => {
  it("retries transient failures then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;

    const request: FreedomApiRequest = {
      patch: async () => {
        calls += 1;
        if (calls < 3) {
          return mockResponse({ status: 503, ok: false, body: "unavailable" });
        }
        return mockResponse({
          status: 200,
          body: JSON.stringify({ id: 42, count_websites: 3, custom_filters: [] }),
        });
      },
    };

    const writer = new HttpFreedomWriter({
      request,
      csrfProvider: async () => "test-csrf-token",
      backoffMs: [1, 2, 3, 4],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await writer.addDomains(42, ["a.com", "b.com"]);
    expect(result.requested).toBe(2);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1, 2]);
  });

  it("does not retry permanent failures", async () => {
    let calls = 0;
    const request: FreedomApiRequest = {
      patch: async () => {
        calls += 1;
        return mockResponse({ status: 400, ok: false, body: "bad" });
      },
    };

    const writer = new HttpFreedomWriter({
      request,
      csrfProvider: async () => "test-csrf-token",
      backoffMs: [1, 2, 3, 4],
      sleep: async () => undefined,
    });

    await expect(writer.addDomains(42, ["a.com"])).rejects.toBeInstanceOf(FreedomValidationError);
    expect(calls).toBe(1);
  });

  it("bounds retry attempts", async () => {
    let calls = 0;
    const request: FreedomApiRequest = {
      patch: async () => {
        calls += 1;
        return mockResponse({ status: 429, ok: false, body: "rate" });
      },
    };

    const writer = new HttpFreedomWriter({
      request,
      csrfProvider: async () => "test-csrf-token",
      backoffMs: [1, 1],
      sleep: async () => undefined,
    });

    await expect(writer.addDomains(42, ["a.com"])).rejects.toBeInstanceOf(FreedomHttpError);
    // initial try + 2 retries
    expect(calls).toBe(3);
  });

  it("sends the expected PATCH payload and CSRF header", async () => {
    const seen: Array<{ data: unknown; headers?: Record<string, string> }> = [];
    const request: FreedomApiRequest = {
      patch: async (_url, options) => {
        seen.push({
          data: options.data,
          ...(options.headers ? { headers: options.headers } : {}),
        });
        return mockResponse({
          status: 200,
          body: JSON.stringify({ id: 7, count_websites: 2 }),
        });
      },
    };

    const writer = new HttpFreedomWriter({
      request,
      csrfProvider: async () => "test-csrf-token",
      sleep: async () => undefined,
    });
    await writer.addDomains(7, ["a.com", "a.com", "b.com"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data).toEqual({ custom_domains_to_add: ["a.com", "b.com"] });
    expect(seen[0]?.headers?.["x-csrf-token"]).toBe("test-csrf-token");
  });

  it("refreshes CSRF once after a 401 then succeeds", async () => {
    let calls = 0;
    let csrfCalls = 0;
    const request: FreedomApiRequest = {
      patch: async (_url, options) => {
        calls += 1;
        if (options.headers?.["x-csrf-token"] === "stale") {
          return mockResponse({ status: 401, ok: false, body: "" });
        }
        return mockResponse({
          status: 200,
          body: JSON.stringify({ id: 7, count_websites: 2 }),
        });
      },
    };

    const writer = new HttpFreedomWriter({
      request,
      csrfProvider: async () => {
        csrfCalls += 1;
        return csrfCalls === 1 ? "stale" : "fresh";
      },
      sleep: async () => undefined,
    });

    await writer.addDomains(7, ["a.com"]);
    expect(calls).toBe(2);
    expect(csrfCalls).toBe(2);
  });
});
