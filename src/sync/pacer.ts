import type { Logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";

export type AdaptivePaceLevel = "normal" | "elevated" | "high";

/**
 * Adaptive inter-batch pacing for Freedom write load.
 *
 * normal:   ~1–2s
 * elevated: ~10s  (after first transient failure)
 * high:     ~30s  (after second)
 * abort:    after continued failures while elevated/high
 */
export class AdaptiveBatchPacer {
  private level: AdaptivePaceLevel = "normal";
  private consecutiveTransientFailures = 0;
  private readonly logger?: Logger;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private aborted = false;

  constructor(options: { logger?: Logger; sleep?: (ms: number) => Promise<void> } = {}) {
    if (options.logger) {
      this.logger = options.logger;
    }
    this.sleepFn = options.sleep ?? sleep;
  }

  recordSuccess(): void {
    this.consecutiveTransientFailures = 0;
    if (this.level !== "normal") {
      this.logger?.info("Freedom recovered; returning to normal batch pacing.");
    }
    this.level = "normal";
  }

  /**
   * Record a known transient HTTP failure (429/5xx with a response).
   * Returns whether the run should abort instead of continuing.
   */
  recordTransientFailure(): boolean {
    this.consecutiveTransientFailures += 1;
    if (this.consecutiveTransientFailures === 1) {
      this.level = "elevated";
      this.logger?.warn("Transient Freedom failure. Elevating inter-batch pause to ~10s.");
      return false;
    }
    if (this.consecutiveTransientFailures === 2) {
      this.level = "high";
      this.logger?.warn("Repeated transient Freedom failure. Elevating inter-batch pause to ~30s.");
      return false;
    }
    this.aborted = true;
    this.logger?.error(
      "Continued transient Freedom failures. Stopping so the next run can re-diff safely.",
    );
    return true;
  }

  shouldAbort(): boolean {
    return this.aborted;
  }

  async delayBeforeNextBatch(): Promise<void> {
    const ms = this.delayMs();
    this.logger?.info(`Waiting ${Math.round(ms / 1000)}s before next batch...`);
    await this.sleepFn(ms);
  }

  private delayMs(): number {
    switch (this.level) {
      case "elevated":
        return 10_000;
      case "high":
        return 30_000;
      case "normal":
      default:
        return 1000 + Math.floor(Math.random() * 1000);
    }
  }
}
