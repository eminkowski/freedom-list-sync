import { describe, expect, it } from "vitest";

import { FREEDOM_CURATED_FILTERS_URL, extractAccountEmail } from "../src/freedom/session-probe.js";

describe("session probe", () => {
  it("uses curated_filters rather than filter_lists as the lightweight auth URL", () => {
    expect(FREEDOM_CURATED_FILTERS_URL).toContain("/curated_filters/");
    expect(FREEDOM_CURATED_FILTERS_URL).not.toContain("/filter_lists/");
  });

  it("extracts account email only from explicit JSON fields", () => {
    expect(extractAccountEmail({ email: "a@b.co" })).toBe("a@b.co");
    expect(extractAccountEmail({ user: { email: "u@x.com" } })).toBe("u@x.com");
    expect(extractAccountEmail({ note: "a@b.co" })).toBeUndefined();
    expect(extractAccountEmail(null)).toBeUndefined();
  });
});
