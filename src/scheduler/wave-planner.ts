import type { QuotaTopology } from "./quota-topology.js";
import { isInsideQuietHours, type QuietHoursOptions } from "./activity-guard.js";

export interface WavePlannerConfig {
  targetWeeklyBurnPct: number;
  windowHours: number;
  waveBufferMinutes: number;
  hardStopBeforeResetMinutes: number;
  minTaskReserveMinutes?: number;
  quietHours?: QuietHoursOptions;
}

export type WaveAction =
  | "STOP_BEFORE_RESET"
  | "QUOTA_ALREADY_BURNED"
  | "WAIT_WINDOW_UNLOCK"
  | "START_WAVE_NOW"
  | "WAIT_UNTIL_START"
  | "FAIL_CLOSED_UNKNOWN_RESET";

export interface WaveTimelineEntry {
  waveIndex: number;
  plannedStartAt: Date;
  estimatedBurnPct: number;
  description: string;
  model?: string | null;
}

export interface WavePlan {
  action: WaveAction;
  wavesNeeded: number;
  remainingPct: number;
  plannedStartAt: Date;
  hardStopAt: Date;
  nextWakeAt: Date | null;
  waveIndex: number;
  timeline: WaveTimelineEntry[];
  summary: string;
  selectedModel?: string | null;
}

export interface ExecutionPlanInput {
  topology: QuotaTopology;
  calibration: {
    primaryPctPerSubWindow: number;
    primaryPctPerHour?: number;
    avgActiveMinutesPerWave?: number;
  };
  config: Partial<WavePlannerConfig>;
  now: Date;
}

export interface WavePlannerInput {
  now: Date;
  weeklyUsedPct: number;
  weeklyResetAt: Date;
  window5hUsedPct: number | null;
  window5hResetAt: Date | null;
  weeklyPctPer5hWave: number;
  config?: Partial<WavePlannerConfig>;
}

export function computeExecutionPlan(input: ExecutionPlanInput): WavePlan {
  const { topology, calibration, now } = input;
  const targetBurn = input.config.targetWeeklyBurnPct ?? 99;
  const bufferMins = input.config.waveBufferMinutes ?? 15;
  const hardStopMins = input.config.hardStopBeforeResetMinutes ?? 20;

  // 1. Unknown topology check (Level 5 fail-closed)
  if (topology.type === "UNKNOWN") {
    return {
      action: "FAIL_CLOSED_UNKNOWN_RESET",
      wavesNeeded: 0,
      remainingPct: 0,
      plannedStartAt: now,
      hardStopAt: now,
      nextWakeAt: null,
      waveIndex: 0,
      timeline: [],
      summary: "Fail-closed: quota topology unknown or reset timestamp unavailable"
    };
  }

  // 2. Primary reset timestamp check (Level 5 fail-closed)
  if (topology.type !== "ROLLING_ONLY") {
    const primary = topology.primaryBucket;
    if (!primary || !primary.resetAt || primary.confidence === "low") {
      return {
        action: "FAIL_CLOSED_UNKNOWN_RESET",
        wavesNeeded: 0,
        remainingPct: 0,
        plannedStartAt: now,
        hardStopAt: now,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: "Fail-closed: primary reset timestamp is null or low confidence"
      };
    }
  }

  // 3. MULTI_BUCKET_CASCADE
  if (topology.type === "MULTI_BUCKET_CASCADE") {
    const availableModel = topology.modelBuckets.find((b) => b.usedPct < targetBurn - 2);
    if (!availableModel) {
      const hardStop = topology.primaryBucket?.resetAt
        ? new Date(new Date(topology.primaryBucket.resetAt).getTime() - hardStopMins * 60_000)
        : now;
      return {
        action: "QUOTA_ALREADY_BURNED",
        wavesNeeded: 0,
        remainingPct: 0,
        plannedStartAt: hardStop,
        hardStopAt: hardStop,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: "All model cascade buckets have reached target burn limit.",
        selectedModel: null
      };
    }

    // Delegate calculation using selected model's bucket
    const subPlan = computeExecutionPlan({
      topology: {
        type: topology.subWindowBucket ? "TWO_TIER_WINDOW" : "SINGLE_CYCLE_CAP",
        primaryBucket: availableModel,
        subWindowBucket: topology.subWindowBucket,
        modelBuckets: [availableModel],
        buckets: topology.buckets
      },
      calibration,
      config: input.config,
      now
    });

    return {
      ...subPlan,
      selectedModel: availableModel.model,
      summary: `[Model: ${availableModel.model}] ${subPlan.summary}`
    };
  }

  // 4. TWO_TIER_WINDOW
  if (topology.type === "TWO_TIER_WINDOW") {
    const primary = topology.primaryBucket!;
    const sub = topology.subWindowBucket!;
    const primaryResetAt = new Date(primary.resetAt!);
    const hardStopAt = new Date(primaryResetAt.getTime() - hardStopMins * 60_000);
    const remainingPct = Math.max(0, targetBurn - primary.usedPct);

    // Hard stop check
    if (now.getTime() >= hardStopAt.getTime()) {
      return {
        action: "STOP_BEFORE_RESET",
        wavesNeeded: 0,
        remainingPct,
        plannedStartAt: hardStopAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: `Hard stop active (${hardStopMins}m before cycle reset). Quota protected.`
      };
    }

    if (remainingPct <= 1) {
      return {
        action: "QUOTA_ALREADY_BURNED",
        wavesNeeded: 0,
        remainingPct,
        plannedStartAt: hardStopAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: `Target burn reached. Only ${remainingPct.toFixed(1)}% remaining.`
      };
    }

    const cSub = Math.max(1, calibration.primaryPctPerSubWindow);
    const wSubHours = sub.durationHours;
    const wavesNeeded = Math.ceil(remainingPct / cSub);
    const totalLeadMs = wavesNeeded * wSubHours * 3600_000 + bufferMins * 60_000;
    const plannedStartAt = new Date(primaryResetAt.getTime() - totalLeadMs);

    // Build timeline
    const timeline: WaveTimelineEntry[] = [];
    for (let i = 1; i <= wavesNeeded; i++) {
      const waveStart = new Date(plannedStartAt.getTime() + (i - 1) * wSubHours * 3600_000);
      const estBurn = Math.min(cSub, Number((remainingPct - (i - 1) * cSub).toFixed(1)));
      timeline.push({
        waveIndex: i,
        plannedStartAt: waveStart,
        estimatedBurnPct: estBurn,
        description: `Ondata ${i}: avvio ${waveStart.toLocaleTimeString()} (burn ~${estBurn}%)`
      });
    }

    // Check if sub-window is saturated
    if (sub.usedPct >= 98 && sub.resetAt && new Date(sub.resetAt).getTime() > now.getTime()) {
      const subReset = new Date(sub.resetAt);
      const nextWake = new Date(subReset.getTime() + 2 * 60_000);

      // Level 4 Defense: block wakeups straddling reset
      if (nextWake.getTime() >= hardStopAt.getTime()) {
        return {
          action: "STOP_BEFORE_RESET",
          wavesNeeded,
          remainingPct,
          plannedStartAt,
          hardStopAt,
          nextWakeAt: null,
          waveIndex: 1,
          timeline,
          summary: `Sub-window unlocks after hard stop. Cycle marked complete.`
        };
      }

      return {
        action: "WAIT_WINDOW_UNLOCK",
        wavesNeeded,
        remainingPct,
        plannedStartAt,
        hardStopAt,
        nextWakeAt: nextWake,
        waveIndex: 1,
        timeline,
        summary: `Sub-window (${wSubHours}h) saturated (${sub.usedPct}%). Waiting unlock at ${subReset.toLocaleTimeString()}.`
      };
    }

    // Start now check
    if (now.getTime() >= plannedStartAt.getTime() && now.getTime() < hardStopAt.getTime()) {
      const timeSinceStart = now.getTime() - plannedStartAt.getTime();
      const waveIndex = Math.min(wavesNeeded, Math.max(1, Math.floor(timeSinceStart / (wSubHours * 3600_000)) + 1));
      return {
        action: "START_WAVE_NOW",
        wavesNeeded,
        remainingPct,
        plannedStartAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex,
        timeline,
        summary: `Executing wave ${waveIndex} of ${wavesNeeded}. Remaining: ${remainingPct.toFixed(1)}%.`
      };
    }

    return {
      action: "WAIT_UNTIL_START",
      wavesNeeded,
      remainingPct,
      plannedStartAt,
      hardStopAt,
      nextWakeAt: plannedStartAt,
      waveIndex: 1,
      timeline,
      summary: `Waiting for wave start at ${plannedStartAt.toLocaleString()} (${wavesNeeded} waves planned).`
    };
  }

  // 5. SINGLE_CYCLE_CAP (e.g. 24h daily, monthly credits, without sub-window)
  if (topology.type === "SINGLE_CYCLE_CAP") {
    const primary = topology.primaryBucket!;
    const primaryResetAt = new Date(primary.resetAt!);
    const hardStopAt = new Date(primaryResetAt.getTime() - hardStopMins * 60_000);
    const remainingPct = Math.max(0, targetBurn - primary.usedPct);

    if (now.getTime() >= hardStopAt.getTime()) {
      return {
        action: "STOP_BEFORE_RESET",
        wavesNeeded: 0,
        remainingPct,
        plannedStartAt: hardStopAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: `Hard stop active for single-cycle cap (${hardStopMins}m before reset).`
      };
    }

    if (remainingPct <= 1) {
      return {
        action: "QUOTA_ALREADY_BURNED",
        wavesNeeded: 0,
        remainingPct,
        plannedStartAt: hardStopAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: `Single-cycle quota already burned (${primary.usedPct}% used).`
      };
    }

    const vPerHour = calibration.primaryPctPerHour ?? (primary.durationHours <= 24 ? 15 : 4);
    const tNeedHours = remainingPct / vPerHour;
    const tNeedMs = tNeedHours * 3600_000 + bufferMins * 60_000;
    const plannedStartAt = new Date(primaryResetAt.getTime() - tNeedMs);

    const timeline: WaveTimelineEntry[] = [
      {
        waveIndex: 1,
        plannedStartAt,
        estimatedBurnPct: remainingPct,
        description: `Sessione continua: avvio ${plannedStartAt.toLocaleTimeString()} (burn stimato ~${remainingPct.toFixed(1)}%)`
      }
    ];

    if (now.getTime() >= plannedStartAt.getTime() && now.getTime() < hardStopAt.getTime()) {
      return {
        action: "START_WAVE_NOW",
        wavesNeeded: 1,
        remainingPct,
        plannedStartAt,
        hardStopAt,
        nextWakeAt: null,
        waveIndex: 1,
        timeline,
        summary: `Executing continuous burn session (${remainingPct.toFixed(1)}% remaining).`
      };
    }

    return {
      action: "WAIT_UNTIL_START",
      wavesNeeded: 1,
      remainingPct,
      plannedStartAt,
      hardStopAt,
      nextWakeAt: plannedStartAt,
      waveIndex: 1,
      timeline,
      summary: `Waiting for continuous session launch at ${plannedStartAt.toLocaleTimeString()}.`
    };
  }

  // 6. ROLLING_ONLY (short rolling window <24h, night slots mode)
  if (topology.type === "ROLLING_ONLY") {
    const sub = topology.subWindowBucket ?? topology.buckets[0]!;
    const remainingPct = Math.max(0, targetBurn - sub.usedPct);

    if (remainingPct <= 1) {
      return {
        action: "QUOTA_ALREADY_BURNED",
        wavesNeeded: 0,
        remainingPct,
        plannedStartAt: now,
        hardStopAt: new Date(now.getTime() + 24 * 3600_000),
        nextWakeAt: null,
        waveIndex: 0,
        timeline: [],
        summary: `Rolling quota already consumed (${sub.usedPct}%).`
      };
    }

    const quietHours = input.config.quietHours ?? {
      enabled: true,
      start: "01:00",
      end: "07:00",
      allowDaytimeIfExpiringWithinHours: 6
    };

    const inQuietHours = isInsideQuietHours(now, quietHours);

    if (inQuietHours) {
      if (sub.usedPct >= 98 && sub.resetAt && new Date(sub.resetAt).getTime() > now.getTime()) {
        const nextWake = new Date(new Date(sub.resetAt).getTime() + 2 * 60_000);
        return {
          action: "WAIT_WINDOW_UNLOCK",
          wavesNeeded: 1,
          remainingPct,
          plannedStartAt: now,
          hardStopAt: new Date(now.getTime() + 6 * 3600_000),
          nextWakeAt: nextWake,
          waveIndex: 1,
          timeline: [],
          summary: `Rolling sub-window saturated. Waiting unlock at ${new Date(sub.resetAt).toLocaleTimeString()}.`
        };
      }

      return {
        action: "START_WAVE_NOW",
        wavesNeeded: 1,
        remainingPct,
        plannedStartAt: now,
        hardStopAt: new Date(now.getTime() + 6 * 3600_000),
        nextWakeAt: null,
        waveIndex: 1,
        timeline: [],
        summary: `Rolling-only night slot active. Executing wave.`
      };
    }

    return {
      action: "WAIT_UNTIL_START",
      wavesNeeded: 1,
      remainingPct,
      plannedStartAt: now,
      hardStopAt: new Date(now.getTime() + 24 * 3600_000),
      nextWakeAt: null,
      waveIndex: 1,
      timeline: [],
      summary: "Outside quiet hours slot for rolling-only quota. Standing by."
    };
  }

  return {
    action: "FAIL_CLOSED_UNKNOWN_RESET",
    wavesNeeded: 0,
    remainingPct: 0,
    plannedStartAt: now,
    hardStopAt: now,
    nextWakeAt: null,
    waveIndex: 0,
    timeline: [],
    summary: "Unhandled topology state"
  };
}

// Backward-compatible helper for existing code and tests
export function computeWavePlan(input: WavePlannerInput): WavePlan {
  const {
    now,
    weeklyUsedPct,
    weeklyResetAt,
    window5hUsedPct,
    window5hResetAt,
    weeklyPctPer5hWave
  } = input;

  const targetBurn = input.config?.targetWeeklyBurnPct ?? 99;
  const hardStopMins = input.config?.hardStopBeforeResetMinutes ?? 10;
  const bufferMins = input.config?.waveBufferMinutes ?? 15;
  const windowHours = input.config?.windowHours ?? 5;

  const topology: QuotaTopology = {
    type: window5hUsedPct !== null ? "TWO_TIER_WINDOW" : "SINGLE_CYCLE_CAP",
    primaryBucket: {
      id: "weekly_all",
      role: "primary",
      scope: "account",
      model: null,
      windowType: "fixed",
      durationHours: 168,
      usedPct: weeklyUsedPct,
      resetAt: weeklyResetAt.toISOString(),
      confidence: "high"
    },
    subWindowBucket:
      window5hUsedPct !== null
        ? {
            id: `rolling_${windowHours}h`,
            role: "sub_window",
            scope: "account",
            model: null,
            windowType: "rolling",
            durationHours: windowHours,
            usedPct: window5hUsedPct,
            resetAt: window5hResetAt ? window5hResetAt.toISOString() : null,
            confidence: "high"
          }
        : null,
    modelBuckets: [],
    buckets: []
  };

  return computeExecutionPlan({
    topology,
    calibration: {
      primaryPctPerSubWindow: weeklyPctPer5hWave,
      primaryPctPerHour: 4
    },
    config: {
      targetWeeklyBurnPct: targetBurn,
      windowHours,
      waveBufferMinutes: bufferMins,
      hardStopBeforeResetMinutes: hardStopMins
    },
    now
  });
}
