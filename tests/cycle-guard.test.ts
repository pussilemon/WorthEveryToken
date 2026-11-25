import { describe, it, expect } from "vitest";
import { CycleGuard } from "../src/scheduler/cycle-guard.js";
import { computeExecutionPlan } from "../src/scheduler/wave-planner.js";
import { classifyTopology } from "../src/scheduler/quota-topology.js";
import { CustomAdapter } from "../src/adapters/custom-adapter.js";

describe("CycleGuard (5 Zero-Bleed Defense Levels)", () => {
  describe("Level 1: Hard-Stop Pre-Reset & Task Fit Check", () => {
    it("should reject starting a task when remaining time to hard stop is less than minTaskReserveMinutes", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      // Hard stop is 5 minutes away, but reserve requires 6 minutes
      const hardStopAt = new Date(now.getTime() + 5 * 60_000);

      const check = CycleGuard.canStartNextTask({
        now,
        hardStopAt,
        minTaskReserveMinutes: 6,
        avgTaskDurationMs: 180_000
      });

      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("HARD_STOP_PRE_RESET");
    });

    it("should reject starting a task when avgTaskDuration exceeds remaining time even if minTaskReserve fits", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      // Hard stop is 8 minutes away, minTaskReserve is 6 minutes, but avg task duration is 10 minutes
      const hardStopAt = new Date(now.getTime() + 8 * 60_000);

      const check = CycleGuard.canStartNextTask({
        now,
        hardStopAt,
        minTaskReserveMinutes: 6,
        avgTaskDurationMs: 10 * 60_000 // 10 minutes
      });

      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("HARD_STOP_PRE_RESET");
    });

    it("should allow starting a task when ample time remains before hard stop", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      // Hard stop is 30 minutes away
      const hardStopAt = new Date(now.getTime() + 30 * 60_000);

      const check = CycleGuard.canStartNextTask({
        now,
        hardStopAt,
        minTaskReserveMinutes: 6,
        avgTaskDurationMs: 180_000
      });

      expect(check.allowed).toBe(true);
    });
  });

  describe("Level 2: Hard Process Deadline Clamping", () => {
    it("should clamp effective timeout to remaining time before deadlineAt", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const deadlineAt = new Date(now.getTime() + 45_000); // 45s left
      const standardTimeoutMs = 180_000; // 3 minutes standard

      const effective = CycleGuard.getEffectiveTimeoutMs(now, deadlineAt, standardTimeoutMs);
      expect(effective).toBe(45_000);
    });

    it("should use standard timeout if deadlineAt is farther in the future", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const deadlineAt = new Date(now.getTime() + 600_000); // 10m left
      const standardTimeoutMs = 180_000; // 3m standard

      const effective = CycleGuard.getEffectiveTimeoutMs(now, deadlineAt, standardTimeoutMs);
      expect(effective).toBe(standardTimeoutMs);
    });

    it("should return 0 timeout if now is already past deadlineAt", () => {
      const now = new Date("2026-11-20T10:05:00Z");
      const deadlineAt = new Date("2026-11-20T10:00:00Z");

      const effective = CycleGuard.getEffectiveTimeoutMs(now, deadlineAt, 180_000);
      expect(effective).toBe(0);
    });

    it("should terminate a hanging process when clamped deadline expires", async () => {
      const adapter = new CustomAdapter({
        binary: "bash",
        audit_args: ["-c", "sleep 10"],
        exec_args: ["-c", "sleep 10"],
        use_pty: false
      });

      const start = Date.now();
      // Clamp deadline to 400ms from now
      const deadlineAt = new Date(Date.now() + 400);

      const result = await adapter.runAudit("test prompt", process.cwd(), {
        deadlineAt
      });

      const elapsed = Date.now() - start;
      // Should terminate near 400ms, definitely not wait 10 seconds!
      expect(elapsed).toBeLessThan(3000);
      expect(result.status).toBe("FAILED");
      expect(result.error).toContain("timed out");
    });
  });

  describe("Level 3: Early Reset Detection / Clock Skew", () => {
    it("should abort when provider used percentage suddenly drops by >= 20%", () => {
      const lockedCycleResetAt = new Date("2026-11-25T10:00:00Z");
      const now = new Date("2026-11-23T10:00:00Z");

      const check = CycleGuard.checkEarlyReset({
        lockedCycleResetAt,
        cyclePeakUsedPct: 85,
        currentResetAt: lockedCycleResetAt,
        currentUsedPct: 2, // Dropped from 85% to 2% (reset occurred!)
        now
      });

      expect(check.abort).toBe(true);
      expect(check.reason).toContain("EARLY_RESET_DETECTED_ABORT");
      expect(check.reason).toContain("Sudden quota drop");
    });

    it("should abort when reset timestamp jumps forward by > 60 minutes", () => {
      const lockedCycleResetAt = new Date("2026-11-25T10:00:00Z");
      const currentResetAt = new Date("2026-12-02T10:00:00Z"); // Jumped forward by 7 days!
      const now = new Date("2026-11-23T10:00:00Z");

      const check = CycleGuard.checkEarlyReset({
        lockedCycleResetAt,
        cyclePeakUsedPct: 70,
        currentResetAt,
        currentUsedPct: 75,
        now
      });

      expect(check.abort).toBe(true);
      expect(check.reason).toContain("EARLY_RESET_DETECTED_ABORT");
      expect(check.reason).toContain("jumped forward");
    });

    it("should abort when system clock reaches or passes lockedCycleResetAt", () => {
      const lockedCycleResetAt = new Date("2026-11-25T10:00:00Z");
      const now = new Date("2026-11-25T10:05:00Z"); // Clock is 5m past reset!

      const check = CycleGuard.checkEarlyReset({
        lockedCycleResetAt,
        cyclePeakUsedPct: 80,
        currentResetAt: lockedCycleResetAt,
        currentUsedPct: 80,
        now
      });

      expect(check.abort).toBe(true);
      expect(check.reason).toContain("EARLY_RESET_DETECTED_ABORT");
      expect(check.reason).toContain("Clock passed cycle reset");
    });

    it("should not abort during normal cycle execution", () => {
      const lockedCycleResetAt = new Date("2026-11-25T10:00:00Z");
      const now = new Date("2026-11-23T10:00:00Z");

      const check = CycleGuard.checkEarlyReset({
        lockedCycleResetAt,
        cyclePeakUsedPct: 60,
        currentResetAt: lockedCycleResetAt,
        currentUsedPct: 65,
        now
      });

      expect(check.abort).toBe(false);
    });
  });

  describe("Level 4: Blocking Wakeups Straddling Reset", () => {
    it("should return false when subWindowResetAt + 2m >= hardStopAt", () => {
      const hardStopAt = new Date("2026-11-25T10:00:00Z");
      // subWindow resets 1 minute before hardStopAt; wake at +2m would be past hardStopAt!
      const subWindowResetAt = new Date("2026-11-25T09:59:00Z");

      const allowed = CycleGuard.shouldScheduleWakeup(subWindowResetAt, hardStopAt);
      expect(allowed).toBe(false);
    });

    it("should return true when subWindowResetAt has plenty of time before hardStopAt", () => {
      const hardStopAt = new Date("2026-11-25T10:00:00Z");
      const subWindowResetAt = new Date("2026-11-25T04:00:00Z"); // 6h before hardStopAt

      const allowed = CycleGuard.shouldScheduleWakeup(subWindowResetAt, hardStopAt);
      expect(allowed).toBe(true);
    });

    it("should close cycle with STOP_BEFORE_RESET in wave planner when sub-window unlocks after hard stop", () => {
      const now = new Date("2026-11-25T09:00:00Z");
      const weeklyResetAt = new Date("2026-11-25T10:00:00Z"); // Hard stop at 09:40
      const subResetAt = new Date("2026-11-25T09:45:00Z"); // Saturated until after hard stop!

      const topology = classifyTopology([
        {
          id: "sub",
          role: "sub_window",
          scope: "account",
          model: null,
          windowType: "rolling",
          durationHours: 5,
          usedPct: 100, // Saturated!
          resetAt: subResetAt.toISOString(),
          confidence: "high"
        },
        {
          id: "weekly",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 168,
          usedPct: 40,
          resetAt: weeklyResetAt.toISOString(),
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 15 },
        config: {
          targetWeeklyBurnPct: 99,
          hardStopBeforeResetMinutes: 20
        },
        now
      });

      expect(plan.action).toBe("STOP_BEFORE_RESET");
      expect(plan.nextWakeAt).toBeNull();
      expect(plan.summary).toContain("Sub-window unlocks after hard stop");
    });
  });

  describe("Level 5: Fail-Closed on Unknown or Low-Confidence Reset", () => {
    it("should reject safe execution if resetAt is null", () => {
      expect(CycleGuard.isResetKnownAndSafe(null)).toBe(false);
    });

    it("should reject safe execution if confidence is low", () => {
      const resetAt = new Date(Date.now() + 3600_000);
      expect(CycleGuard.isResetKnownAndSafe(resetAt, "low")).toBe(false);
    });

    it("should allow execution if resetAt is known with high or medium confidence", () => {
      const resetAt = new Date(Date.now() + 3600_000);
      expect(CycleGuard.isResetKnownAndSafe(resetAt, "medium")).toBe(true);
      expect(CycleGuard.isResetKnownAndSafe(resetAt, "high")).toBe(true);
    });

    it("should return FAIL_CLOSED_UNKNOWN_RESET in wave planner when primary reset is missing", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const topology = classifyTopology([
        {
          id: "sub",
          role: "sub_window",
          scope: "account",
          model: null,
          windowType: "rolling",
          durationHours: 5,
          usedPct: 10,
          resetAt: new Date("2026-11-20T14:00:00Z").toISOString(),
          confidence: "high"
        },
        {
          id: "weekly",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 168,
          usedPct: 30,
          resetAt: null, // Null reset!
          confidence: "low"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 12 },
        config: { targetWeeklyBurnPct: 99 },
        now
      });

      expect(plan.action).toBe("FAIL_CLOSED_UNKNOWN_RESET");
      expect(plan.summary).toContain("Fail-closed");
    });
  });
});
