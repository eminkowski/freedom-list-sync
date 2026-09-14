import type { BrowserContext, Page } from "playwright";

import { FREEDOM_HOME_URL, FREEDOM_ORIGIN } from "./auth.js";
import { FreedomAuthenticationError } from "./errors.js";

/**
 * Read Rails-style CSRF token from Freedom's HTML meta tag.
 * Never log the token value.
 */
export async function readCsrfToken(
  context: BrowserContext,
  options: { forceNavigate?: boolean } = {},
): Promise<string> {
  const page = context.pages()[0] ?? (await context.newPage());
  const forceNavigate = options.forceNavigate === true;

  if (forceNavigate || !isFreedomPage(page)) {
    await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" });
  }

  const token = await page.locator('meta[name="csrf-token"]').getAttribute("content");
  if (!token || token.trim() === "") {
    // Try one forced navigation in case the current page is a non-app route.
    if (!forceNavigate) {
      return readCsrfToken(context, { forceNavigate: true });
    }
    throw new FreedomAuthenticationError();
  }

  return token;
}

function isFreedomPage(page: Page): boolean {
  try {
    const url = new URL(page.url());
    return url.origin === FREEDOM_ORIGIN;
  } catch {
    return false;
  }
}
