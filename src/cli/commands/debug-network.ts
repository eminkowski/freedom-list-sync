import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { Command } from "commander";
import type { Request, Response } from "playwright";

import { FREEDOM_HOME_URL, FREEDOM_ORIGIN, getAuthStatePath } from "../../freedom/auth.js";
import { closeFreedomContext, openFreedomContext } from "../../freedom/client.js";
import { createLogger, type Logger } from "../../utils/logger.js";

const SENSITIVE_BODY_KEYS = [
  "password",
  "passwd",
  "token",
  "csrf",
  "authenticity_token",
  "authorization",
  "session",
  "secret",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_BODY_CHARS = 8_000;
const DEFAULT_TEST_DOMAIN = "example.com";
const DEFAULT_LIST_NAME = "Social Media";

interface CapturedExchange {
  id: number;
  method: string;
  url: string;
  resourceType: string;
  contentType?: string;
  requestBody?: string;
  status?: number;
  responseContentType?: string;
  responseBody?: string;
  matchedBecause: string[];
  likelyMutation: boolean;
  containsTestDomain: boolean;
  startedAt: string;
}

/**
 * Observe Freedom's own network traffic while the user manually performs
 * a single action (add a domain, or create a blocklist).
 */
export function registerDebugNetworkCommand(program: Command): void {
  program
    .command("debug:network")
    .description("Inspect Freedom network requests while manually editing lists")
    .option("--action <action>", "add-domain | create", "add-domain")
    .option("--list <name>", "List name to mention in instructions", DEFAULT_LIST_NAME)
    .option("--domain <domain>", "Test domain to mention in instructions", DEFAULT_TEST_DOMAIN)
    .option("--verbose", "Log more Freedom-origin requests (still sanitized)", false)
    .action(
      async (options: { action: string; list: string; domain: string; verbose?: boolean }) => {
        const logger = createLogger();
        const verbose = options.verbose === true;
        const action = parseDebugAction(options.action);
        const exchanges: CapturedExchange[] = [];
        let nextId = 1;

        logger.info("Network inspection active.");
        logger.info(`Session: ${getAuthStatePath()}`);
        logger.info(`Action:  ${action}`);
        logger.info("");
        printActionInstructions(logger, action, options.list, options.domain);
        logger.info("");
        logger.info("Relevant Freedom requests will be logged below.");
        logger.info("Sensitive headers/tokens are redacted and never persisted.");
        logger.info("");

        const context = await openFreedomContext({ headed: true });
        const page = context.pages()[0] ?? (await context.newPage());

        const pendingByRequest = new WeakMap<Request, CapturedExchange>();

        page.on("request", (request) => {
          const exchange = maybeCaptureRequest(request, {
            id: nextId,
            verbose,
            testDomain: options.domain,
            listName: options.list,
            action,
          });
          if (!exchange) {
            return;
          }
          nextId += 1;
          pendingByRequest.set(request, exchange);
          exchanges.push(exchange);
          logRequest(logger, exchange);
        });

        page.on("response", async (response) => {
          const request = response.request();
          const exchange = pendingByRequest.get(request);
          if (!exchange) {
            return;
          }
          await attachResponse(exchange, response);
          logResponse(logger, exchange);
        });

        await page.goto(FREEDOM_HOME_URL, { waitUntil: "domcontentloaded" });

        const rl = createInterface({ input, output });
        try {
          const prompt =
            action === "create"
              ? "Press Enter when finished creating the test blocklist...\n"
              : "Press Enter when finished adding the test domain...\n";
          await rl.question(prompt);
        } finally {
          rl.close();
          await closeFreedomContext(context);
        }

        printSummary(logger, exchanges, options.domain);
        if (action === "create") {
          logger.info("");
          logger.info(
            "Look for a mutating POST/PUT to a filter_lists (or similar) endpoint above. " +
              "That request is what createFilterList(name) should reproduce.",
          );
        }
      },
    );
}

type DebugAction = "add-domain" | "create";

function parseDebugAction(value: string): DebugAction {
  if (value === "add-domain" || value === "create") {
    return value;
  }
  throw new Error(`Invalid --action: ${value} (expected add-domain | create)`);
}

function printActionInstructions(
  logger: Logger,
  action: DebugAction,
  listName: string,
  domain: string,
): void {
  logger.info("In the Freedom browser:");
  if (action === "create") {
    logger.info(`1. Create exactly one new custom blocklist named: ${listName}`);
    logger.info("2. Do not add domains yet — empty list is ideal.");
    logger.info("3. Save/confirm the create.");
    logger.info("4. Return here and press Enter when finished.");
    return;
  }

  logger.info(`1. Open the "${listName}" filter list.`);
  logger.info(`2. Add exactly one test domain: ${domain}`);
  logger.info("3. Save the change.");
  logger.info("4. Return here and press Enter when finished.");
}

function maybeCaptureRequest(
  request: Request,
  options: {
    id: number;
    verbose: boolean;
    testDomain: string;
    listName: string;
    action: DebugAction;
  },
): CapturedExchange | null {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return null;
  }

  if (url.origin !== FREEDOM_ORIGIN) {
    return null;
  }

  const method = request.method().toUpperCase();
  const resourceType = request.resourceType();
  const body = request.postData() ?? undefined;
  const matchedBecause = matchReasons({
    url,
    method,
    ...(body !== undefined ? { body } : {}),
    testDomain: options.testDomain,
    listName: options.listName,
    action: options.action,
    verbose: options.verbose,
    resourceType,
  });

  if (matchedBecause.length === 0) {
    return null;
  }

  const headers = request.headers();
  const contentType = headers["content-type"];
  const sanitizedBody = body ? sanitizePayload(body, contentType) : undefined;
  const containsTestDomain = bodyContainsDomain(body, options.testDomain);

  return {
    id: options.id,
    method,
    url: `${url.origin}${url.pathname}${url.search}`,
    resourceType,
    ...(contentType ? { contentType } : {}),
    ...(sanitizedBody ? { requestBody: sanitizedBody } : {}),
    matchedBecause,
    likelyMutation: MUTATING_METHODS.has(method),
    containsTestDomain,
    startedAt: new Date().toISOString(),
  };
}

function matchReasons(input: {
  url: URL;
  method: string;
  body?: string;
  testDomain: string;
  listName: string;
  action: DebugAction;
  verbose: boolean;
  resourceType: string;
}): string[] {
  const reasons: string[] = [];
  const pathAndQuery = `${input.url.pathname}${input.url.search}`.toLowerCase();
  const full = input.url.href.toLowerCase();

  if (pathAndQuery.includes("filter") || full.includes("filter")) {
    reasons.push("url contains filter");
  }
  if (pathAndQuery.includes("list") || full.includes("list")) {
    reasons.push("url contains list");
  }
  if (pathAndQuery.includes("custom") || full.includes("custom")) {
    reasons.push("url contains custom");
  }
  if (MUTATING_METHODS.has(input.method)) {
    reasons.push(`${input.method} to freedom.to`);
  }
  if (bodyContainsDomain(input.body, input.testDomain)) {
    reasons.push("body contains test domain");
  }
  if (input.action === "create" && bodyContainsListName(input.body, input.listName)) {
    reasons.push("body contains list name");
  }

  if (reasons.length > 0) {
    return reasons;
  }

  if (!input.verbose) {
    return [];
  }

  // Verbose still skips obvious noise.
  if (
    input.resourceType === "image" ||
    input.resourceType === "font" ||
    input.resourceType === "stylesheet" ||
    input.resourceType === "media"
  ) {
    return [];
  }

  return ["verbose"];
}

function bodyContainsListName(body: string | undefined, listName: string): boolean {
  if (!body || !listName) {
    return false;
  }
  return body.toLowerCase().includes(listName.toLowerCase());
}

async function attachResponse(exchange: CapturedExchange, response: Response): Promise<void> {
  exchange.status = response.status();
  const headers = response.headers();
  const contentType = headers["content-type"];
  if (contentType) {
    exchange.responseContentType = contentType;
  }

  // Only attempt body capture for likely-interesting responses.
  if (!exchange.likelyMutation && !exchange.containsTestDomain && !isFilterListsUrl(exchange.url)) {
    return;
  }

  try {
    const text = await response.text();
    if (!text) {
      return;
    }
    exchange.responseBody = sanitizePayload(text, contentType);
  } catch {
    // Response body may be unavailable for some redirected/opaque responses.
  }
}

function logRequest(logger: Logger, exchange: CapturedExchange): void {
  logger.info("");
  logger.info(`[#${exchange.id}] ${exchange.method} ${exchange.url}`);
  logger.info(`  resourceType: ${exchange.resourceType}`);
  logger.info(`  matched: ${exchange.matchedBecause.join("; ")}`);
  if (exchange.contentType) {
    logger.info(`  Content-Type: ${exchange.contentType}`);
  }
  if (exchange.requestBody) {
    logger.info("  Body:");
    for (const line of exchange.requestBody.split("\n")) {
      logger.info(`  ${line}`);
    }
  }
}

function logResponse(logger: Logger, exchange: CapturedExchange): void {
  logger.info(`  Status: ${exchange.status ?? "unknown"}`);
  if (exchange.responseContentType) {
    logger.info(`  Response Content-Type: ${exchange.responseContentType}`);
  }
  if (exchange.responseBody) {
    logger.info("  Response body:");
    for (const line of summarizeResponseBody(exchange.responseBody).split("\n")) {
      logger.info(`  ${line}`);
    }
  }
}

function printSummary(logger: Logger, exchanges: CapturedExchange[], testDomain: string): void {
  logger.info("");
  logger.info("=".repeat(72));
  logger.info("Network inspection summary");
  logger.info("=".repeat(72));
  logger.info(`Captured relevant exchanges: ${exchanges.length}`);
  logger.info(`Test domain: ${testDomain}`);
  logger.info("");

  const mutationCandidates = exchanges.filter(
    (exchange) =>
      exchange.likelyMutation &&
      (exchange.containsTestDomain ||
        exchange.matchedBecause.some(
          (reason) =>
            reason.includes("filter") || reason.includes("list") || reason.includes("custom"),
        )),
  );

  const followUps = exchanges.filter(
    (exchange) =>
      !mutationCandidates.includes(exchange) &&
      (isFilterListsUrl(exchange.url) || exchange.method === "GET"),
  );

  if (mutationCandidates.length === 0) {
    logger.info("Observed mutation request:");
    logger.info("  None clearly identified.");
    logger.info("  Review the full log above for ambiguous candidates.");
  } else {
    logger.info(`Observed mutation request candidate(s): ${mutationCandidates.length}`);
    for (const exchange of mutationCandidates) {
      logger.info("");
      logger.info(`Candidate #${exchange.id}`);
      logger.info(`Method: ${exchange.method}`);
      logger.info(`URL: ${exchange.url}`);
      logger.info(`Content-Type: ${exchange.contentType ?? "(none)"}`);
      logger.info("Request body shape:");
      logger.info(describeShape(exchange.requestBody));
      logger.info(`Response status: ${exchange.status ?? "(unknown)"}`);
      logger.info("Response body shape:");
      logger.info(describeShape(exchange.responseBody));
      if (exchange.requestBody) {
        logger.info("Sanitized request body:");
        logger.info(exchange.requestBody);
      }
      if (exchange.responseBody) {
        logger.info("Sanitized response body (truncated if large):");
        logger.info(summarizeResponseBody(exchange.responseBody));
      }
    }
  }

  logger.info("");
  logger.info("Observed follow-up request(s):");
  const interestingFollowUps = followUps.filter(
    (exchange) => isFilterListsUrl(exchange.url) || exchange.containsTestDomain,
  );
  if (interestingFollowUps.length === 0) {
    logger.info("  None clearly identified beyond the candidates above.");
  } else {
    for (const exchange of interestingFollowUps) {
      logger.info(
        `  [#${exchange.id}] ${exchange.method} ${exchange.url} -> ${exchange.status ?? "?"}`,
      );
    }
  }

  logger.info("");
  logger.info("Investigation checklist (report only what was observed):");
  logger.info("1. Method used for the mutation candidate(s)");
  logger.info("2. Exact endpoint path");
  logger.info("3. Whether list ID was in the path and/or body");
  logger.info("4. Whether domains were sent individually or as a full list");
  logger.info("5. Whether multiple domains appeared in one payload");
  logger.info("6. Any evidence about the 50-domain UI limit");
  logger.info("7. Whether CSRF fields appeared in the sanitized body");
  logger.info("8. Whether the existing Playwright session was enough");
  logger.info("9. Successful response contents");
  logger.info("10. Whether only custom_filters or a full object was submitted");
}

function sanitizePayload(raw: string, contentType?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  if ((contentType ?? "").includes("application/json") || looksLikeJson(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return `${JSON.stringify(redactSensitiveValues(parsed), null, 2)}\n`;
    } catch {
      // Fall through to text sanitization.
    }
  }

  if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
    return sanitizeFormUrlEncoded(trimmed);
  }

  return redactSensitiveText(trimmed).slice(0, MAX_BODY_CHARS);
}

function redactSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValues(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveValues(nested);
    }
  }
  return result;
}

function sanitizeFormUrlEncoded(body: string): string {
  const params = new URLSearchParams(body);
  const lines: string[] = [];
  for (const [key, value] of params.entries()) {
    if (isSensitiveKey(key)) {
      lines.push(`${key}=[REDACTED]`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n").slice(0, MAX_BODY_CHARS);
}

function redactSensitiveText(text: string): string {
  return text.replace(
    new RegExp(
      `("?(?:${SENSITIVE_BODY_KEYS.join("|")})"?(?:\\s*[:=]\\s*|\\s+)(?:"[^"]*"|'[^']*'|[^&\\s,}"]+))`,
      "gi",
    ),
    (match) => {
      const separator = match.includes("=") ? "=" : match.includes(":") ? ":" : " ";
      const key = match.split(/[:=]/)[0] ?? "secret";
      return `${key.trim()}${separator}[REDACTED]`;
    },
  );
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_BODY_KEYS.some((part) => lower.includes(part));
}

function bodyContainsDomain(body: string | undefined, domain: string): boolean {
  if (!body) {
    return false;
  }
  return body.toLowerCase().includes(domain.toLowerCase());
}

function isFilterListsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === FREEDOM_ORIGIN && parsed.pathname.includes("filter_lists");
  } catch {
    return url.includes("filter_lists");
  }
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function describeShape(body: string | undefined): string {
  if (!body) {
    return "  (empty / none)";
  }

  const trimmed = body.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return `  ${describeJsonShape(parsed)}`;
  } catch {
    const preview = trimmed.replace(/\s+/g, " ").slice(0, 120);
    return `  text(${trimmed.length} chars): ${preview}`;
  }
}

function describeJsonShape(value: unknown, depth = 0): string {
  if (depth > 3) {
    return "...";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "array(0)";
    }
    return `array(${value.length}) of ${describeJsonShape(value[0], depth + 1)}`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object);
    return `object{${keys.join(", ")}}`;
  }
  return typeof value;
}

function summarizeResponseBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 2_000) {
    return trimmed;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      const compact: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(root)) {
        if (key === "filter_lists" && Array.isArray(value)) {
          compact.filter_lists = {
            count: value.length,
            note: "truncated; full lists omitted from summary",
            sampleIds: value.slice(0, 3).map((item) => {
              if (item && typeof item === "object" && "id" in item) {
                return (item as { id: unknown }).id;
              }
              return null;
            }),
          };
        } else if (Array.isArray(value) && value.length > 5) {
          compact[key] = {
            count: value.length,
            sample: value.slice(0, 2),
            note: "truncated",
          };
        } else {
          compact[key] = redactSensitiveValues(value);
        }
      }
      return JSON.stringify(compact, null, 2);
    }
  } catch {
    // Fall through.
  }

  return `${trimmed.slice(0, 2_000)}\n... [truncated ${trimmed.length - 2_000} chars]`;
}
