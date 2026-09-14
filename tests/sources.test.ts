import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AmbiguousSourceFormatError,
  StrictParseError,
  UnsupportedSourceFormatError,
} from "../src/sources/errors.js";
import { detectSourceFormat, loadSourceFile, parseSourceContent } from "../src/sources/fetch.js";
import { assertDomainCountLimit, assertSourceByteLimit, SourceTooLargeError } from "../src/sources/limits.js";
import { CsvSourceParser, parseCsvLine } from "../src/sources/csv-source.js";
import { HostsSourceParser } from "../src/sources/hosts-source.js";
import { JsonSourceParser } from "../src/sources/json-source.js";
import { DomainListSourceParser } from "../src/sources/plain-domain-source.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

describe("HostsSourceParser", () => {
  it("parses a generic hosts list", () => {
    const parsed = new HostsSourceParser().parse(fixture("generic-hosts.txt"));
    expect(parsed.format).toBe("hosts");
    expect(parsed.domains).toEqual(["bar.example.org", "example.com", "foo.example.com"]);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.ignoredLineCount).toBeGreaterThan(0);
  });

  it("handles inline hosts comments", () => {
    const parsed = new HostsSourceParser().parse("0.0.0.0 example.com # comment\n");
    expect(parsed.domains).toEqual(["example.com"]);
  });

  it("keeps subdomains distinct from parents", () => {
    const parsed = new HostsSourceParser().parse(`
0.0.0.0 cdn.example.com
0.0.0.0 example.com
`);
    expect(parsed.domains).toEqual(["cdn.example.com", "example.com"]);
  });

  it("accepts 127.0.0.1 block mappings", () => {
    const parsed = new HostsSourceParser().parse(`
127.0.0.1 ads.example.com
0.0.0.0 keep.example.com
`);
    expect(parsed.domains).toEqual(["ads.example.com", "keep.example.com"]);
  });
});

describe("DomainListSourceParser", () => {
  it("parses plain domains", () => {
    const parsed = new DomainListSourceParser().parse(fixture("plain-domains.txt"));
    expect(parsed.format).toBe("domains");
    expect(parsed.domains).toEqual(["bar.net", "example.com", "foo.example.org"]);
    expect(parsed.duplicateCount).toBe(1);
  });

  it("supports inline comments and rejects URLs", () => {
    const parsed = new DomainListSourceParser().parse(`
example.com # keep
https://example.org/path
`);
    expect(parsed.domains).toEqual(["example.com"]);
    expect(parsed.invalidLineCount).toBe(1);
  });

  it("counts mixed invalid lines", () => {
    const parsed = new DomainListSourceParser().parse(fixture("mixed-invalid-domains.txt"));
    expect(parsed.domains).toEqual(["example.com", "valid-sub.example.com"]);
    expect(parsed.invalidLineCount).toBeGreaterThanOrEqual(4);
  });

  it("fails in strict mode when invalid lines exist", () => {
    expect(() =>
      new DomainListSourceParser().parse(fixture("mixed-invalid-domains.txt"), { strict: true }),
    ).toThrow(StrictParseError);
  });
});

describe("CsvSourceParser", () => {
  it("parses a headered CSV using the domain column by default", () => {
    const parsed = new CsvSourceParser().parse(fixture("domains.csv"));
    expect(parsed.format).toBe("csv");
    expect(parsed.domains).toEqual(["cdn.example.com", "facebook.com", "instagram.com"]);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.invalidLineCount).toBe(1);
  });

  it("parses quoted fields that contain commas", () => {
    const parsed = new CsvSourceParser().parse(
      [
        "domain,notes",
        '"facebook.com","social, network"',
        '"instagram.com","mobile, app"',
      ].join("\n"),
    );
    expect(parsed.domains).toEqual(["facebook.com", "instagram.com"]);
    expect(parseCsvLine('"facebook.com","social, network"')).toEqual([
      "facebook.com",
      "social, network",
    ]);
  });

  it("supports numeric and named domain columns", () => {
    const byIndex = new CsvSourceParser().parse("facebook.com,social\ninstagram.com,social\n", {
      domainColumn: 0,
    });
    expect(byIndex.domains).toEqual(["facebook.com", "instagram.com"]);

    const byName = new CsvSourceParser().parse(fixture("domains.csv"), {
      domainColumn: "domain",
    });
    expect(byName.domains).toEqual(["cdn.example.com", "facebook.com", "instagram.com"]);
  });

  it("refuses to guess a domain column without a known header", () => {
    expect(() =>
      new CsvSourceParser().parse("facebook.com,social\ninstagram.com,social\n"),
    ).toThrow(/domain column is ambiguous/i);
    expect(new CsvSourceParser().canParse("facebook.com,social\ninstagram.com,social\n")).toBe(
      false,
    );
  });
});

describe("JsonSourceParser", () => {
  it("parses a JSON string array", () => {
    const parsed = new JsonSourceParser().parse(fixture("domains-array.json"));
    expect(parsed.format).toBe("json");
    expect(parsed.domains).toEqual(["facebook.com", "instagram.com"]);
    expect(parsed.duplicateCount).toBe(1);
    expect(parsed.invalidLineCount).toBe(1);
  });

  it("parses wrapped domain arrays and URL-looking values", () => {
    const parsed = new JsonSourceParser().parse(fixture("domains-wrapped.json"));
    expect(parsed.domains).toEqual(["facebook.com", "instagram.com", "twitter.com"]);
  });

  it("parses object arrays with default and explicit fields", () => {
    const parsed = new JsonSourceParser().parse(fixture("domains-objects.json"));
    expect(parsed.domains).toEqual(["facebook.com", "instagram.com"]);

    const explicit = new JsonSourceParser().parse(
      `[{"host":"news.example.com"},{"host":"work.example.com"}]`,
      { domainField: "host" },
    );
    expect(explicit.domains).toEqual(["news.example.com", "work.example.com"]);
  });

  it("errors clearly when domain-field is missing or non-string", () => {
    expect(() =>
      new JsonSourceParser().parse(`[{"category":"social"},{"category":"news"}]`),
    ).toThrow(/Pass --domain-field/i);

    expect(() =>
      new JsonSourceParser().parse(`[{"host":123}]`, { domainField: "host" }),
    ).toThrow(/must be a string/i);
  });
});

describe("auto detection", () => {
  it("detects hosts format confidently", () => {
    expect(detectSourceFormat(fixture("generic-hosts.txt"))).toBe("hosts");
  });

  it("detects plain domains confidently", () => {
    expect(detectSourceFormat(fixture("plain-domains.txt"))).toBe("domains");
  });

  it("detects csv and json confidently", () => {
    expect(detectSourceFormat(fixture("domains.csv"))).toBe("csv");
    expect(detectSourceFormat(fixture("domains-array.json"))).toBe("json");
  });

  it("does not treat malformed JSON as a domain list", () => {
    expect(() => detectSourceFormat('{\n"domains": [')).toThrow(/looks like JSON/i);
    expect(() =>
      detectSourceFormat(`[
facebook.com
instagram.com
]`),
    ).toThrow(/looks like JSON/i);
  });

  it("does not auto-detect CSV without a known domain header", () => {
    expect(() =>
      detectSourceFormat("facebook.com,social\ninstagram.com,social\nnews.example.com,news\n"),
    ).toThrow(AmbiguousSourceFormatError);
  });

  it("fails on ambiguous mixed content instead of guessing", () => {
    expect(() => detectSourceFormat(fixture("ambiguous-mixed.txt"))).toThrow(
      AmbiguousSourceFormatError,
    );
  });

  it("rejects Adblock/uBlock syntax", () => {
    expect(() => detectSourceFormat(fixture("adblock-filters.txt"))).toThrow(
      UnsupportedSourceFormatError,
    );
    expect(() => detectSourceFormat(fixture("adblock-filters.txt"))).toThrow(/Adblock\/uBlock/i);
  });

  it("rejects URL lists", () => {
    expect(() => detectSourceFormat(fixture("url-list.txt"))).toThrow(/URL list/i);
  });
});

describe("parseSourceContent casing/dedupe", () => {
  it("normalizes casing and trailing dots", () => {
    const parsed = parseSourceContent(
      `
Example.COM.
FOO.Example.ORG
example.com
`,
      "domains",
    );
    expect(parsed.domains).toEqual(["example.com", "foo.example.org"]);
    expect(parsed.duplicateCount).toBe(1);
  });
});

describe("source limits and local files", () => {
  it("enforces byte and domain caps", () => {
    expect(() => assertSourceByteLimit(100, 50)).toThrow(SourceTooLargeError);
    expect(() => assertDomainCountLimit(10, 5)).toThrow(SourceTooLargeError);
  });

  it("loads a local domains file", async () => {
    const parsed = await loadSourceFile(path.join(fixturesDir, "plain-domains.txt"), "domains");
    expect(parsed.url.startsWith("file://")).toBe(true);
    expect(parsed.domains).toEqual(["bar.net", "example.com", "foo.example.org"]);
  });
});
