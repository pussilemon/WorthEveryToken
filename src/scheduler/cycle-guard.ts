import { logger } from "../utils/logger.js";

export interface TaskFitCheckOptions {
  now: Date;
  hardStopAt: Date;
  avgTaskDurationMs?: number;
  minTaskReserveMinutes?: number;
}

export interface EarlyResetCheckOptions {
  lockedCycleResetAt: Date | null;
  cyclePeakUsedPct: number | null;
  currentResetAt: Date | null;
  currentUsedPct: number | null;
  now: Date;
}

export class CycleGuard {
  // Level 1: Hard-Stop Pre-Reset & Task Fit Check
  public static canStartNextTask(options: TaskFitCheckOptions): { allowed: boolean; reason?: string } {
    const { now, hardStopAt } = options;
    const avgDuration = options.avgTaskDurationMs ?? 180_000; // default 3 min
    const minReserveMs = (options.minTaskReserveMinutes ?? 6) * 60_000;
    const requiredMarginMs = Math.max(avgDuration, minReserveMs);

    if (now.getTime() + requiredMarginMs >= hardStopAt.getTime()) {
      const remainingMinutes = ((hardStopAt.getTime() - now.getTime()) / 60_000).toFixed(1);
      logger.warn(
        { now: now.toISOString(), hardStopAt: hardStopAt.toISOString(), remainingMinutes },
        "CycleGuard [Level 1]: Insufficient time before hard stop to safely fit task. Halting."
      );
      return {
        allowed: false,
        reason: `HARD_STOP_PRE_RESET (Only ${remainingMinutes}m until hard stop, requires ${requiredMarginMs / 60000}m)`
      };
    }

    return { allowed: true };
  }

  // Level 2: Hard Deadline Clamping
  public static getEffectiveTimeoutMs(now: Date, deadlineAt: Date, standardTimeoutMs: number): number {
    const remainingMs = deadlineAt.getTime() - now.getTime();
    if (remainingMs <= 0) {
      return 0;
    }
    return Math.min(standardTimeoutMs, remainingMs);
  }

  // Level 3: Early Reset Detection / Clock Skew
  public static checkEarlyReset(options: EarlyResetCheckOptions): { abort: boolean; reason?: string } {
    const { lockedCycleResetAt, cyclePeakUsedPct, currentResetAt, currentUsedPct, now } = options;

    if (!lockedCycleResetAt) {
      return { abort: false };
    }

    // Controllo C: Orologio oltre il confine
    if (now.getTime() >= lockedCycleResetAt.getTime()) {
      logger.warn(
        { now: now.toISOString(), lockedCycleResetAt: lockedCycleResetAt.toISOString() },
        "CycleGuard [Level 3 - Control C]: Clock has reached or passed locked reset boundary. Halting."
      );
      return { abort: true, reason: "EARLY_RESET_DETECTED_ABORT (Clock passed cycle reset)" };
    }

    // Controllo A: Salto in avanti del timestamp di reset (> 60 minuti)
    if (currentResetAt) {
      const resetDriftMs = currentResetAt.getTime() - lockedCycleResetAt.getTime();
      if (resetDriftMs > 60 * 60_000) {
        logger.warn(
          { locked: lockedCycleResetAt.toISOString(), current: currentResetAt.toISOString(), driftHours: resetDriftMs / 3600_000 },
          "CycleGuard [Level 3 - Control A]: Provider reset timestamp jumped forward by >60m. Old cycle is reset!"
        );
        return { abort: true, reason: "EARLY_RESET_DETECTED_ABORT (Reset timestamp jumped forward)" };
      }
    }

    // Controllo B: Crollo improvviso della percentuale usata (>= 20%)
    if (cyclePeakUsedPct !== null && currentUsedPct !== null) {
      const dropPct = cyclePeakUsedPct - currentUsedPct;
      if (dropPct >= 20) {
        logger.warn(
          { cyclePeakUsedPct, currentUsedPct, dropPct },
          "CycleGuard [Level 3 - Control B]: Sudden drop in used percentage (>= 20%). Quota reset occurred!"
        );
        return { abort: true, reason: "EARLY_RESET_DETECTED_ABORT (Sudden quota drop detected)" };
      }
    }

    return { abort: false };
  }

  // Level 4: Blocco risvegli a cavallo del reset
  public static shouldScheduleWakeup(subWindowResetAt: Date, hardStopAt: Date): boolean {
    const nextWakeMs = subWindowResetAt.getTime() + 2 * 60_000;
    if (nextWakeMs >= hardStopAt.getTime()) {
      logger.info(
        { nextWake: new Date(nextWakeMs).toISOString(), hardStopAt: hardStopAt.toISOString() },
        "CycleGuard [Level 4]: Next wake time straddles or exceeds hard stop. Blocking wake, completing cycle."
      );
      return false;
    }
    return true;
  }

  // Level 5: Fail-closed se il reset è sconosciuto
  public static isResetKnownAndSafe(resetAt: Date | null, confidence: "high" | "medium" | "low" = "medium"): boolean {
    if (!resetAt) {
      logger.warn("CycleGuard [Level 5]: Primary reset timestamp is null. Fail-closed enforced.");
      return false;
    }
    if (confidence === "low") {
      logger.warn("CycleGuard [Level 5]: Primary reset confidence is low. Fail-closed enforced.");
      return false;
    }
    return true;
  }
}
