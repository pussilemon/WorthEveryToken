import { describe, it, expect } from "vitest";
import { computeWavePlan } from "../src/scheduler/wave-planner.js";

describe("WavePlanner", () => {
  const weeklyResetAt = new Date("2026-11-30T08:00:00.000Z"); // Monday 08:00 UTC

  it("calculates exact user scenario: 27% quota left / 9% per wave -> 3 waves starting at Reset - 15h15m", () => {
    // 16 hours before reset
    const now = new Date(weeklyResetAt.getTime() - 16 * 3600_000);

    const plan = computeWavePlan({
      now,
      weeklyUsedPct: 72,
      weeklyResetAt,
      window5hUsedPct: 20,
      window5hResetAt: null,
      weeklyPctPer5hWave: 9,
      config: {
        targetWeeklyBurnPct: 99,
        windowHours: 5,
        waveBufferMinutes: 15,
        hardStopBeforeResetMinutes: 10
      }
    });

    expect(plan.remainingPct).toBe(27);
    expect(plan.wavesNeeded).toBe(3);

    // Lead time: 3 * 5h + 15m = 15h 15m (54,900,000 ms)
    const expectedPlannedStart = new Date(weeklyResetAt.getTime() - (15 * 3600_000 + 15 * 60_000));
    expect(plan.plannedStartAt.toISOString()).toBe(expectedPlannedStart.toISOString());

    // Since now (Reset - 16h) < plannedStartAt (Reset - 15h15m), action must be WAIT_UNTIL_START
    expect(plan.action).toBe("WAIT_UNTIL_START");
    expect(plan.nextWakeAt?.toISOString()).toBe(expectedPlannedStart.toISOString());
    expect(plan.timeline.length).toBe(3);
    expect(plan.timeline[0]?.waveIndex).toBe(1);
    expect(plan.timeline[1]?.waveIndex).toBe(2);
    expect(plan.timeline[2]?.waveIndex).toBe(3);
  });

  it("triggers START_WAVE_NOW when now is between plannedStartAt and hardStopAt", () => {
    // Exactly at Reset - 15h (after plannedStartAt Reset - 15h15m)
    const now = new Date(weeklyResetAt.getTime() - 15 * 3600_000);

    const plan = computeWavePlan({
      now,
      weeklyUsedPct: 72,
      weeklyResetAt,
      window5hUsedPct: 10,
      window5hResetAt: null,
      weeklyPctPer5hWave: 9
    });

    expect(plan.action).toBe("START_WAVE_NOW");
    expect(plan.waveIndex).toBe(1);
    expect(plan.wavesNeeded).toBe(3);
  });

  it("triggers WAIT_WINDOW_UNLOCK when current 5-hour window is saturated (>= 98%)", () => {
    const now = new Date(weeklyResetAt.getTime() - 14 * 3600_000);
    const window5hResetAt = new Date(now.getTime() + 2 * 3600_000); // resets in 2 hours

    const plan = computeWavePlan({
      now,
      weeklyUsedPct: 75,
      weeklyResetAt,
      window5hUsedPct: 99,
      window5hResetAt,
      weeklyPctPer5hWave: 9
    });

    expect(plan.action).toBe("WAIT_WINDOW_UNLOCK");
    // Next wake is window5hResetAt + 2m
    expect(plan.nextWakeAt?.getTime()).toBe(window5hResetAt.getTime() + 2 * 60_000);
  });

  it("triggers STOP_BEFORE_RESET inside the 10-minute pre-reset buffer", () => {
    // 5 minutes before weekly reset
    const now = new Date(weeklyResetAt.getTime() - 5 * 60_000);

    const plan = computeWavePlan({
      now,
      weeklyUsedPct: 60,
      weeklyResetAt,
      window5hUsedPct: 0,
      window5hResetAt: null,
      weeklyPctPer5hWave: 9,
      config: {
        hardStopBeforeResetMinutes: 10
      }
    });

    expect(plan.action).toBe("STOP_BEFORE_RESET");
    expect(plan.wavesNeeded).toBe(0);
  });

  it("triggers QUOTA_ALREADY_BURNED when remaining quota is <= 1%", () => {
    const now = new Date(weeklyResetAt.getTime() - 12 * 3600_000);

    const plan = computeWavePlan({
      now,
      weeklyUsedPct: 98.5,
      weeklyResetAt,
      window5hUsedPct: 10,
      window5hResetAt: null,
      weeklyPctPer5hWave: 9,
      config: {
        targetWeeklyBurnPct: 99
      }
    });

    expect(plan.action).toBe("QUOTA_ALREADY_BURNED");
    expect(plan.wavesNeeded).toBe(0);
  });
});
