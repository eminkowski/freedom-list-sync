import { describe, expect, it, vi } from "vitest";

import { FreedomAuthenticationError, FreedomValidationError } from "../src/freedom/errors.js";
import {
  FREEDOM_CREATE_FILTER_LIST_URL,
  HttpFreedomListCreator,
  buildCreateFilterListPayload,
  interpretCreateFilterListResponse,
} from "../src/freedom/list-creator.js";

describe("list creator", () => {
  it("builds the observed create payload", () => {
    expect(buildCreateFilterListPayload(" Social Media 2 ")).toEqual({
      name: "Social Media 2",
    });
    expect(FREEDOM_CREATE_FILTER_LIST_URL).toBe("https://freedom.to/filter_lists/");
  });

  it("rejects empty names", () => {
    expect(() => buildCreateFilterListPayload("   ")).toThrow(FreedomValidationError);
  });

  it("parses HTTP 201 create responses", async () => {
    const list = await interpretCreateFilterListResponse("FLS Create Probe", {
      status: () => 201,
      ok: () => true,
      headers: () => ({ "content-type": "application/json" }),
      text: async () =>
        JSON.stringify({
          id: 6633996,
          name: "FLS Create Probe",
          count_websites: 0,
          custom_filters: [],
        }),
    });

    expect(list).toEqual({
      id: 6633996,
      name: "FLS Create Probe",
      count_websites: 0,
      custom_filters: [],
    });
  });

  it("treats auth redirects as authentication errors", async () => {
    await expect(
      interpretCreateFilterListResponse("X", {
        status: () => 302,
        ok: () => false,
        headers: () => ({}),
        text: async () => "",
      }),
    ).rejects.toBeInstanceOf(FreedomAuthenticationError);
  });

  it("POSTs name with CSRF headers through HttpFreedomListCreator", async () => {
    const post = vi.fn(async () => ({
      status: () => 201,
      ok: () => true,
      headers: () => ({ "content-type": "application/json" }),
      text: async () =>
        JSON.stringify({
          id: 42,
          name: "Work Focus",
          count_websites: 0,
          custom_filters: [],
        }),
    }));

    const creator = new HttpFreedomListCreator({
      request: { post },
      csrfProvider: async () => "csrf-test-token",
      backoffMs: [],
    });

    const created = await creator.createFilterList("Work Focus");
    expect(created.id).toBe(42);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "https://freedom.to/filter_lists/",
      expect.objectContaining({
        data: { name: "Work Focus" },
        headers: expect.objectContaining({
          "x-csrf-token": "csrf-test-token",
          "content-type": "application/json",
        }),
      }),
    );
  });
});
