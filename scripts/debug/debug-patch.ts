import { FREEDOM_ORIGIN } from "../../src/freedom/auth.js";
import { openFreedomContext } from "../../src/freedom/client.js";

async function main(): Promise<void> {
  const context = await openFreedomContext({ headed: false });
  try {
    const get = await context.request.get(`${FREEDOM_ORIGIN}/filter_lists/`, {
      failOnStatusCode: false,
    });
    console.log("GET", get.status(), get.headers()["content-type"]);

    const patch = await context.request.patch(`${FREEDOM_ORIGIN}/filter_lists/6618658`, {
      failOnStatusCode: false,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      data: {
        custom_domains_to_add: ["probe-debug-1.example.com"],
      },
    });
    const text = await patch.text();
    console.log("PATCH status", patch.status());
    console.log("PATCH ok", patch.ok());
    console.log("PATCH ct", patch.headers()["content-type"]);
    const safeHeaders = Object.fromEntries(
      Object.entries(patch.headers()).filter(
        ([key]) => !/cookie|auth|csrf|token|set-cookie/i.test(key),
      ),
    );
    console.log("PATCH headers", JSON.stringify(safeHeaders, null, 2));
    console.log("PATCH body preview", text.slice(0, 800));
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
