import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import type { AnomalyReport } from "../telemetry/burn-profiler.js";

export type CircuitBreakerState = "CLOSED" | "HALF_OPEN" | "OPEN";

export interface CircuitBreakerOptions {
  maxConsecutiveFailures?: number;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures: number;
  private lastErrorHashPerTask = new Map<string, string>();
  private tripReason: string | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  }

  public getState(): CircuitBreakerState {
    return this.state;
  }

  public getTripReason(): string | null {
    return this.tripReason;
  }

  public isOpen(): boolean {
    return this.state === "OPEN";
  }

  public recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      logger.info("Circuit breaker recovering: HALF_OPEN -> CLOSED");
      this.state = "CLOSED";
    }
    this.consecutiveFailures = 0;
  }

  public recordFailure(taskId: string, errorOutput?: string, anomaly?: AnomalyReport): void {
    this.consecutiveFailures++;
    logger.warn(
      { taskId, consecutiveFailures: this.consecutiveFailures, max: this.maxConsecutiveFailures },
      "Circuit breaker recorded failure"
    );

    // 1. Check max consecutive failures
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trip(`Exceeded ${this.maxConsecutiveFailures} consecutive failures`);
      return;
    }

    // 2. Check identical error hash twice in a row for the same task
    if (errorOutput && errorOutput.trim().length > 0) {
      const hash = crypto.createHash("sha256").update(errorOutput.trim()).digest("hex");
      const prevHash = this.lastErrorHashPerTask.get(taskId);
      if (prevHash && prevHash === hash) {
        this.trip(`Identical error hash repeated twice consecutively on task ${taskId}`);
        return;
      }
      this.lastErrorHashPerTask.set(taskId, hash);
    }

    // 3. Check critical loop from burn profiler
    if (anomaly?.loopDetected) {
      this.trip(`Burn profiler detected degenerative loop: ${anomaly.reason}`);
      return;
    }

    if (this.consecutiveFailures >= Math.ceil(this.maxConsecutiveFailures / 2)) {
      this.state = "HALF_OPEN";
    }
  }

  public trip(reason: string): void {
    this.state = "OPEN";
    this.tripReason = reason;
    logger.error({ reason }, "Circuit breaker TRIPPED -> OPEN");
  }

  public reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.lastErrorHashPerTask.clear();
    this.tripReason = null;
  }
}
