import { FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { openFreedomContext } from "../../src/freedom/client.js";

async function main(): Promise<void> {
  const context = await openFreedomContext({ headed: false });
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`${FREEDOM_ORIGIN}/`, { waitUntil: "domcontentloaded" });

    const meta = await page.evaluate(() => {
      const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
      const csrfParam = document.querySelector('meta[name="csrf-param"]')?.getAttribute("content");
      return {
        csrfPresent: Boolean(csrf),
        csrfLength: csrf?.length ?? 0,
        csrfParam,
        csrf: csrf ?? null,
      };
    });

    const cookies = await context.cookies(FREEDOM_ORIGIN);
    console.log(
      "cookie names:",
      cookies
        .map((cookie) => cookie.name)
        .sort()
        .join(", "),
    );
    console.log("meta csrf-param:", meta.csrfParam);
    console.log("meta csrf present:", meta.csrfPresent, "length:", meta.csrfLength);

    const csrfCookie = cookies.find((cookie) => /csrf|xsrf|authenticity/i.test(cookie.name));

    const attempts: Array<{ label: string; headers: Record<string, string> }> = [
      {
        label: "json-only",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
      },
      {
        label: "origin-referer",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: FREEDOM_ORIGIN,
          referer: `${FREEDOM_ORIGIN}/`,
        },
      },
      {
        label: "x-requested-with",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: FREEDOM_ORIGIN,
          referer: `${FREEDOM_ORIGIN}/`,
          "x-requested-with": "XMLHttpRequest",
        },
      },
    ];

    if (meta.csrf) {
      attempts.push({
        label: "x-csrf-token-meta",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: FREEDOM_ORIGIN,
          referer: `${FREEDOM_ORIGIN}/`,
          "x-csrf-token": meta.csrf,
          "x-requested-with": "XMLHttpRequest",
        },
      });
    }

    if (csrfCookie?.value) {
      attempts.push({
        label: `header-from-cookie:${csrfCookie.name}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: FREEDOM_ORIGIN,
          referer: `${FREEDOM_ORIGIN}/`,
          "x-csrf-token": decodeURIComponent(csrfCookie.value),
          "x-xsrf-token": decodeURIComponent(csrfCookie.value),
          "x-requested-with": "XMLHttpRequest",
        },
      });
    }

    for (const attempt of attempts) {
      const response = await context.request.patch(`${FREEDOM_ORIGIN}/filter_lists/6618658`, {
        failOnStatusCode: false,
        headers: attempt.headers,
        data: {
          custom_domains_to_add: [`probe-auth-${Date.now()}.example.com`],
        },
      });
      const preview = (await response.text()).slice(0, 120).replace(/\s+/g, " ");
      console.log(
        `${attempt.label}: status=${response.status()} ct=${response.headers()["content-type"] ?? ""} body=${JSON.stringify(preview)}`,
      );
      if (response.ok()) {
        console.log("SUCCESS with", attempt.label);
        break;
      }
    }
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
