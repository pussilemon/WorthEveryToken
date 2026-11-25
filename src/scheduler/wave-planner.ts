export interface WavePlannerConfig {
  targetWeeklyBurnPct: number;
  windowHours: number;
  waveBufferMinutes: number;
  hardStopBeforeResetMinutes: number;
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

export type WaveAction =
  | "STOP_BEFORE_RESET"
  | "QUOTA_ALREADY_BURNED"
  | "WAIT_WINDOW_UNLOCK"
  | "START_WAVE_NOW"
  | "WAIT_UNTIL_START";

export interface WaveTimelineEntry {
  waveIndex: number;
  plannedStartAt: Date;
  estimatedBurnPct: number;
  description: string;
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
}

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
  const windowHours = input.config?.windowHours ?? 5;
  const bufferMins = input.config?.waveBufferMinutes ?? 15;
  const hardStopMins = input.config?.hardStopBeforeResetMinutes ?? 10;

  const hardStopAt = new Date(weeklyResetAt.getTime() - hardStopMins * 60_000);
  const remainingPct = Math.max(0, targetBurn - weeklyUsedPct);

  // 1. Hard stop check: inside the safety buffer before weekly reset
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
      summary: `Hard stop active (${hardStopMins}m before weekly reset). No waves will run to protect new cycle tokens.`
    };
  }

  // 2. Quota already burned check
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
      summary: `Target weekly burn (${targetBurn}%) reached. Only ${remainingPct.toFixed(1)}% remaining.`
    };
  }

  // 3. Compute needed waves
  const rate = Math.max(1, weeklyPctPer5hWave);
  const wavesNeeded = Math.ceil(remainingPct / rate);
  const totalLeadMs = wavesNeeded * windowHours * 3600_000 + bufferMins * 60_000;
  const plannedStartAt = new Date(weeklyResetAt.getTime() - totalLeadMs);

  // 4. Build timeline
  const timeline: WaveTimelineEntry[] = [];
  for (let i = 1; i <= wavesNeeded; i++) {
    const waveStart = new Date(plannedStartAt.getTime() + (i - 1) * windowHours * 3600_000);
    const msBeforeReset = weeklyResetAt.getTime() - waveStart.getTime();
    const hBefore = Math.floor(msBeforeReset / 3600_000);
    const mBefore = Math.floor((msBeforeReset % 3600_000) / 60_000);
    const estBurn = Math.min(rate, Number((remainingPct - (i - 1) * rate).toFixed(1)));

    timeline.push({
      waveIndex: i,
      plannedStartAt: waveStart,
      estimatedBurnPct: estBurn,
      description: `Ondata ${i} (Reset - ${hBefore}h ${mBefore}m): burn stimato ~${estBurn}%`
    });
  }

  // 5. Check if current 5h window is saturated
  if (
    window5hUsedPct !== null &&
    window5hUsedPct >= 98 &&
    window5hResetAt &&
    window5hResetAt.getTime() > now.getTime()
  ) {
    const nextWakeAt = new Date(window5hResetAt.getTime() + 2 * 60_000);
    return {
      action: "WAIT_WINDOW_UNLOCK",
      wavesNeeded,
      remainingPct,
      plannedStartAt,
      hardStopAt,
      nextWakeAt,
      waveIndex: 1,
      timeline,
      summary: `5-hour window saturated (${window5hUsedPct}%). Waiting for unlock at ${window5hResetAt.toLocaleTimeString()}.`
    };
  }

  // 6. Check if we should start now
  if (now.getTime() >= plannedStartAt.getTime() && now.getTime() < hardStopAt.getTime()) {
    const timeSinceStart = now.getTime() - plannedStartAt.getTime();
    const waveSlot = Math.min(wavesNeeded, Math.floor(timeSinceStart / (windowHours * 3600_000)) + 1);
    const currentWaveIndex = Math.max(1, waveSlot);

    return {
      action: "START_WAVE_NOW",
      wavesNeeded,
      remainingPct,
      plannedStartAt,
      hardStopAt,
      nextWakeAt: null,
      waveIndex: currentWaveIndex,
      timeline,
      summary: `Time to execute wave ${currentWaveIndex} of ${wavesNeeded}. Remaining quota: ${remainingPct.toFixed(1)}%.`
    };
  }

  // 7. Otherwise, wait until planned start
  return {
    action: "WAIT_UNTIL_START",
    wavesNeeded,
    remainingPct,
    plannedStartAt,
    hardStopAt,
    nextWakeAt: plannedStartAt,
    waveIndex: 1,
    timeline,
    summary: `Waiting for wave launch window at ${plannedStartAt.toLocaleString()} (${wavesNeeded} waves planned).`
  };
}
