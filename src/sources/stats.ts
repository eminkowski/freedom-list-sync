/**
 * Shared helpers for printing source parse metadata in CLI commands.
 */
import { formatNumber } from "../sync/sync.js";
import type { ParsedSource } from "./source.js";
import type { Logger } from "../utils/logger.js";

export function logParsedSourceStats(logger: Logger, source: ParsedSource): void {
  logger.info(`Source format:                  ${source.format}`);
  logger.info(`Input lines:                    ${formatNumber(source.inputLineCount)}`);
  logger.info(`Valid domains:                  ${formatNumber(source.domains.length)}`);
  logger.info(`Duplicates removed:             ${formatNumber(source.duplicateCount)}`);
  logger.info(`Ignored comments/blank/noise:   ${formatNumber(source.ignoredLineCount)}`);
  logger.info(`Invalid lines:                  ${formatNumber(source.invalidLineCount)}`);
}
