import { describe, it, expect } from "vitest";
import { classifyTopology, getPrimaryRemainingPct } from "../src/scheduler/quota-topology.js";
import { computeExecutionPlan } from "../src/scheduler/wave-planner.js";
import { classifyRateLimitError } from "../src/scheduler/calibration-engine.js";
import type { QuotaBucket } from "../src/config/schema.js";

describe("QuotaTopology Engine", () => {
  describe("classifyTopology", () => {
    it("should classify TWO_TIER_WINDOW with sub-windows of 3h, 5h, and 6h", () => {
      const subWindows = [3, 5, 6];
      for (const hours of subWindows) {
        const buckets: QuotaBucket[] = [
          {
            id: `sub_${hours}h`,
            role: "sub_window",
            scope: "account",
            model: null,
            windowType: "rolling",
            durationHours: hours,
            usedPct: 40,
            resetAt: new Date(Date.now() + hours * 3600_000).toISOString(),
            confidence: "high"
          },
          {
            id: "weekly_7d",
            role: "primary",
            scope: "account",
            model: null,
            windowType: "fixed",
            durationHours: 168,
            usedPct: 25,
            resetAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
            confidence: "high"
          }
        ];

        const topology = classifyTopology(buckets);
        expect(topology.type).toBe("TWO_TIER_WINDOW");
        expect(topology.subWindowBucket?.durationHours).toBe(hours);
        expect(topology.primaryBucket?.durationHours).toBe(168);
      }
    });

    it("should classify SINGLE_CYCLE_CAP with 24h daily and 720h monthly caps", () => {
      // 24h Daily cap
      const dailyBuckets: QuotaBucket[] = [
        {
          id: "daily_24h",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 24,
          usedPct: 15,
          resetAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
          confidence: "high"
        }
      ];
      const dailyTopo = classifyTopology(dailyBuckets);
      expect(dailyTopo.type).toBe("SINGLE_CYCLE_CAP");
      expect(dailyTopo.primaryBucket?.durationHours).toBe(24);
      expect(dailyTopo.subWindowBucket).toBeNull();

      // 720h Monthly cap
      const monthlyBuckets: QuotaBucket[] = [
        {
          id: "monthly_720h",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 720,
          usedPct: 50,
          resetAt: new Date(Date.now() + 300 * 3600_000).toISOString(),
          confidence: "high"
        }
      ];
      const monthlyTopo = classifyTopology(monthlyBuckets);
      expect(monthlyTopo.type).toBe("SINGLE_CYCLE_CAP");
      expect(monthlyTopo.primaryBucket?.durationHours).toBe(720);
    });

    it("should classify ROLLING_ONLY with 5h rolling window without primary", () => {
      const rollingBuckets: QuotaBucket[] = [
        {
          id: "rolling_5h",
          role: "sub_window",
          scope: "account",
          model: null,
          windowType: "rolling",
          durationHours: 5,
          usedPct: 60,
          resetAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
          confidence: "medium"
        }
      ];

      const topo = classifyTopology(rollingBuckets);
      expect(topo.type).toBe("ROLLING_ONLY");
      expect(topo.subWindowBucket?.durationHours).toBe(5);
      expect(topo.primaryBucket).toBeNull();
    });

    it("should classify MULTI_BUCKET_CASCADE with distinct model buckets and sort by quality", () => {
      const cascadeBuckets: QuotaBucket[] = [
        {
          id: "sonnet_bucket",
          role: "primary",
          scope: "model",
          model: "claude-3-5-sonnet",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 10,
          resetAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
          confidence: "high"
        },
        {
          id: "opus_bucket",
          role: "primary",
          scope: "model",
          model: "claude-3-7-opus",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 95,
          resetAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
          confidence: "high"
        }
      ];

      const topo = classifyTopology(cascadeBuckets);
      expect(topo.type).toBe("MULTI_BUCKET_CASCADE");
      expect(topo.modelBuckets.length).toBe(2);
      // Opus (quality 100) should be ranked higher than Sonnet (quality 80)
      expect(topo.modelBuckets[0]?.model).toBe("claude-3-7-opus");
      expect(topo.modelBuckets[1]?.model).toBe("claude-3-5-sonnet");
    });

    it("should classify empty or invalid buckets as UNKNOWN", () => {
      expect(classifyTopology([]).type).toBe("UNKNOWN");
    });

    it("should calculate primary remaining percentage correctly", () => {
      const topo = classifyTopology([
        {
          id: "p1",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 168,
          usedPct: 45,
          resetAt: null,
          confidence: "high"
        }
      ]);
      expect(getPrimaryRemainingPct(topo, 99)).toBe(54);
    });
  });

  describe("computeExecutionPlan with All Topologies", () => {
    it("should compute execution plan for TWO_TIER_WINDOW", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const weeklyReset = new Date("2026-11-23T10:00:00Z"); // 72h ahead

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
          resetAt: weeklyReset.toISOString(),
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 12 },
        config: {
          targetWeeklyBurnPct: 99,
          windowHours: 5,
          waveBufferMinutes: 15,
          hardStopBeforeResetMinutes: 20
        },
        now
      });

      expect(plan.wavesNeeded).toBe(6); // Math.ceil((99 - 30) / 12) = 6
      expect(plan.remainingPct).toBe(69);
      expect(plan.action).toBe("WAIT_UNTIL_START");
      expect(plan.plannedStartAt.getTime()).toBeLessThan(plan.hardStopAt.getTime());
      expect(plan.timeline.length).toBe(6);
    });

    it("should compute execution plan for SINGLE_CYCLE_CAP", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const dailyReset = new Date("2026-11-21T00:00:00Z"); // 14h ahead

      const topology = classifyTopology([
        {
          id: "daily",
          role: "primary",
          scope: "account",
          model: null,
          windowType: "fixed",
          durationHours: 24,
          usedPct: 40,
          resetAt: dailyReset.toISOString(),
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 10, primaryPctPerHour: 8 },
        config: {
          targetWeeklyBurnPct: 99,
          hardStopBeforeResetMinutes: 20
        },
        now
      });

      expect(plan.wavesNeeded).toBe(1);
      expect(plan.remainingPct).toBe(59);
      expect(plan.hardStopAt.getTime()).toBe(dailyReset.getTime() - 20 * 60_000);
    });

    it("should compute execution plan for ROLLING_ONLY in quiet hours", () => {
      const now = new Date("2026-11-20T03:00:00Z"); // 3 AM (within quiet hours 01:00-07:00)
      const topology = classifyTopology([
        {
          id: "sub",
          role: "sub_window",
          scope: "account",
          model: null,
          windowType: "rolling",
          durationHours: 5,
          usedPct: 10,
          resetAt: new Date("2026-11-20T07:00:00Z").toISOString(),
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 20 },
        config: {
          targetWeeklyBurnPct: 99,
          quietHours: {
            enabled: true,
            start: "01:00",
            end: "07:00",
            allowDaytimeIfExpiringWithinHours: 6
          }
        },
        now
      });

      expect(plan.action).toBe("START_WAVE_NOW");
      expect(plan.remainingPct).toBe(89);
    });

    it("should auto-cascade from exhausted model #1 to model #2 with quota in MULTI_BUCKET_CASCADE", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const resetAt = new Date("2026-11-22T10:00:00Z").toISOString();

      const topology = classifyTopology([
        {
          id: "opus",
          role: "primary",
          scope: "model",
          model: "claude-3-7-opus",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 99, // Exhausted!
          resetAt,
          confidence: "high"
        },
        {
          id: "sonnet",
          role: "primary",
          scope: "model",
          model: "claude-3-5-sonnet",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 20, // Has plenty of quota!
          resetAt,
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 15 },
        config: { targetWeeklyBurnPct: 99 },
        now
      });

      // Should automatically select Sonnet because Opus is exhausted
      expect(plan.selectedModel).toBe("claude-3-5-sonnet");
      expect(plan.remainingPct).toBe(79); // 99 - 20 = 79
    });

    it("should return QUOTA_ALREADY_BURNED when all models in cascade are exhausted", () => {
      const now = new Date("2026-11-20T10:00:00Z");
      const resetAt = new Date("2026-11-22T10:00:00Z").toISOString();

      const topology = classifyTopology([
        {
          id: "opus",
          role: "primary",
          scope: "model",
          model: "claude-3-7-opus",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 99,
          resetAt,
          confidence: "high"
        },
        {
          id: "sonnet",
          role: "primary",
          scope: "model",
          model: "claude-3-5-sonnet",
          windowType: "fixed",
          durationHours: 168,
          usedPct: 98,
          resetAt,
          confidence: "high"
        }
      ]);

      const plan = computeExecutionPlan({
        topology,
        calibration: { primaryPctPerSubWindow: 15 },
        config: { targetWeeklyBurnPct: 99 },
        now
      });

      expect(plan.action).toBe("QUOTA_ALREADY_BURNED");
      expect(plan.selectedModel).toBeNull();
    });
  });

  describe("classifyRateLimitError Self-Discovery", () => {
    it("should classify TRANSIENT_THROTTLE for short wait times or concurrency overload", () => {
      const now = new Date("2026-11-20T12:00:00Z");

      // Short seconds wait
      const r1 = classifyRateLimitError("Rate limit exceeded. Please retry in 45s.", null, now);
      expect(r1.type).toBe("TRANSIENT_THROTTLE");
      expect(r1.backoffSec).toBe(45);

      // Overloaded message
      const r2 = classifyRateLimitError("Server overloaded. Please retry later.", null, now);
      expect(r2.type).toBe("TRANSIENT_THROTTLE");
      expect(r2.backoffSec).toBe(30);

      // RPM exceeded
      const r3 = classifyRateLimitError("Requests Per Minute (RPM) exceeded. Please slow down.", null, now);
      expect(r3.type).toBe("TRANSIENT_THROTTLE");
    });

    it("should classify SUB_WINDOW_EXHAUSTED for intermediate waits (15m - 12h)", () => {
      const now = new Date("2026-11-20T12:00:00Z");

      const r1 = classifyRateLimitError("You have reached your 5-hour limit. Try again in 3 hours.", null, now);
      expect(r1.type).toBe("SUB_WINDOW_EXHAUSTED");
      expect(r1.subWindowDurationHours).toBe(3);

      const futureReset = new Date("2026-11-20T16:00:00Z"); // 4 hours later
      const r2 = classifyRateLimitError("Usage limit reached. Resets at 16:00.", futureReset, now);
      expect(r2.type).toBe("SUB_WINDOW_EXHAUSTED");
      expect(r2.subWindowDurationHours).toBe(4);
    });

    it("should classify PRIMARY_QUOTA_EXHAUSTED for long waits (> 12h) or explicit weekly messages", () => {
      const now = new Date("2026-11-20T12:00:00Z");

      const r1 = classifyRateLimitError("You have exhausted your weekly limit. Resets next Monday.", null, now);
      expect(r1.type).toBe("PRIMARY_QUOTA_EXHAUSTED");

      const longReset = new Date("2026-11-23T12:00:00Z"); // 72 hours later
      const r2 = classifyRateLimitError("Quota cap reached.", longReset, now);
      expect(r2.type).toBe("PRIMARY_QUOTA_EXHAUSTED");
    });
  });
});
