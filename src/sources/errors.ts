export class AmbiguousSourceFormatError extends Error {
  constructor(message?: string) {
    super(
      message ??
        [
          "Unable to confidently detect source format.",
          "",
          "Use one of:",
          "",
          "  --source-format hosts",
          "  --source-format domains",
          "  --source-format csv",
          "  --source-format json",
        ].join("\n"),
    );
    this.name = "AmbiguousSourceFormatError";
  }
}

export class UnsupportedSourceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSourceFormatError";
  }
}

export class StrictParseError extends Error {
  readonly invalidLineCount: number;

  constructor(invalidLineCount: number, format: string) {
    super(
      `Strict parse failed for ${format} source: ${invalidLineCount} invalid line(s). ` +
        "Fix the source or omit --strict to skip invalid lines.",
    );
    this.name = "StrictParseError";
    this.invalidLineCount = invalidLineCount;
  }
}
