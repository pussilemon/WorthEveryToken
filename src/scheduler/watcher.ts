import fs from "node:fs";
import {
  loadGlobalConfig,
  loadMachineState,
  saveMachineState,
  updateActiveProject
} from "../config/global-store.js";
import { getAdapter } from "../adapters/registry.js";
import { CalibrationEngine } from "./calibration-engine.js";
import { computeWavePlan } from "./wave-planner.js";
import { loadConfig } from "../config/loader.js";
import { Orchestrator } from "../core/orchestrator.js";
import { logger } from "../utils/logger.js";

export interface WatchTickResult {
  executed: boolean;
  action: string;
  reason: string;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runWatchTick(): Promise<WatchTickResult> {
  const globalConfig = loadGlobalConfig();
  const machineState = loadMachineState();

  // 1. Guard: no active project
  if (!machineState.activeProject) {
    logger.debug("No active project scheduled in ~/.wet/state.json. Watcher tick complete.");
    return { executed: false, action: "NONE", reason: "No active project" };
  }

  const { activeProject } = machineState;

  // 2. Guard: project paused
  if (activeProject.status === "paused") {
    logger.debug({ project: activeProject.repoName }, "Active project is paused. Skipping tick.");
    return { executed: false, action: "PAUSED", reason: "Project paused" };
  }

  // 3. Guard: check if an active run PID is already alive
  if (machineState.activeRunPid !== null) {
    if (isPidAlive(machineState.activeRunPid)) {
      logger.info(
        { pid: machineState.activeRunPid, project: activeProject.repoName },
        "Another wave process is already running. Preventing overlapping execution."
      );
      return { executed: false, action: "RUNNING", reason: `PID ${machineState.activeRunPid} is alive` };
    } else {
      logger.warn(
        { pid: machineState.activeRunPid },
        "Stale activeRunPid detected (process no longer alive). Clearing PID lock."
      );
      machineState.activeRunPid = null;
      saveMachineState(machineState);
    }
  }

  // 4. Instantiate universal adapter and probe usage
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  logger.info({ provider: globalConfig.provider }, "Probing provider usage for scheduled wave check...");

  const usage = await adapter.probeUsage();
  const now = new Date();

  // Record usage snapshot in machine state
  machineState.lastKnownUsage = {
    provider: usage.provider,
    probedAt: usage.probedAt.toISOString(),
    source: usage.source,
    weeklyUsedPct: usage.weeklyUsedPct,
    weeklyResetAt: usage.weeklyResetAt ? usage.weeklyResetAt.toISOString() : null,
    window5hUsedPct: usage.window5hUsedPct,
    window5hResetAt: usage.window5hResetAt ? usage.window5hResetAt.toISOString() : null,
    detectedModel: usage.detectedModel
  };

  // Determine weekly reset timestamp
  let weeklyResetAt = usage.weeklyResetAt;
  if (!weeklyResetAt) {
    // Fallback calculation using schedule config
    const targetDay = globalConfig.schedule.fallback_weekly_reset_day;
    const [hStr, mStr] = globalConfig.schedule.fallback_weekly_reset_time.split(":");
    const hour = parseInt(hStr ?? "8", 10);
    const min = parseInt(mStr ?? "0", 10);
    const daysMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const dayIndex = daysMap[targetDay] ?? 1;

    const fallbackDate = new Date(now);
    fallbackDate.setHours(hour, min, 0, 0);
    let addDays = (dayIndex - fallbackDate.getDay() + 7) % 7;
    if (addDays === 0 && fallbackDate.getTime() <= now.getTime()) {
      addDays = 7;
    }
    fallbackDate.setDate(fallbackDate.getDate() + addDays);
    weeklyResetAt = fallbackDate;
  }

  // 5. Get rate from Calibration Engine
  const calibrationEngine = new CalibrationEngine();
  if (globalConfig.calibration.sync_external_benchmarks) {
    await calibrationEngine.syncExternalBenchmarks(
      globalConfig.calibration.benchmark_source_url,
      globalConfig.calibration.benchmark_cache_ttl_hours
    );
  }

  const { rate: weeklyPctPer5hWave } = calibrationEngine.getRateForProvider(
    globalConfig.provider,
    globalConfig.subscription_tier
  );

  // 6. Compute wave plan
  const plan = computeWavePlan({
    now,
    weeklyUsedPct: usage.weeklyUsedPct ?? 0,
    weeklyResetAt,
    window5hUsedPct: usage.window5hUsedPct,
    window5hResetAt: usage.window5hResetAt,
    weeklyPctPer5hWave,
    config: {
      targetWeeklyBurnPct: globalConfig.schedule.target_weekly_burn_pct,
      windowHours: globalConfig.schedule.window_hours,
      waveBufferMinutes: globalConfig.schedule.wave_buffer_minutes,
      hardStopBeforeResetMinutes: globalConfig.schedule.hard_stop_before_reset_minutes
    }
  });

  logger.info(
    { action: plan.action, wavesNeeded: plan.wavesNeeded, summary: plan.summary },
    "Wave planner assessment"
  );

  // Handle plan actions
  if (plan.action === "WAIT_UNTIL_START" || plan.action === "WAIT_WINDOW_UNLOCK") {
    updateActiveProject({
      nextWakeAt: plan.nextWakeAt ? plan.nextWakeAt.toISOString() : null,
      status: plan.action === "WAIT_WINDOW_UNLOCK" ? "waiting_window_reset" : "armed"
    });
    saveMachineState(machineState);
    return { executed: false, action: plan.action, reason: plan.summary };
  }

  if (plan.action === "STOP_BEFORE_RESET" || plan.action === "QUOTA_ALREADY_BURNED") {
    updateActiveProject({
      status: "completed_cycle",
      nextWakeAt: null
    });
    saveMachineState(machineState);
    return { executed: false, action: plan.action, reason: plan.summary };
  }

  // START_WAVE_NOW
  logger.info({ project: activeProject.repoPath }, "Starting scheduled wave execution!");
  machineState.activeRunPid = process.pid;
  saveMachineState(machineState);

  updateActiveProject({
    status: "running_wave",
    lastWaveStartedAt: new Date().toISOString(),
    lastWaveWeeklyPctBefore: usage.weeklyUsedPct
  });

  try {
    if (!fs.existsSync(activeProject.repoPath)) {
      throw new Error(`Repository path does not exist: ${activeProject.repoPath}`);
    }

    const wetConfig = loadConfig(activeProject.repoPath);
    const orchestrator = new Orchestrator(wetConfig, adapter);

    const waveResult = await orchestrator.runWave({
      hardStopAt: plan.hardStopAt,
      resume: true
    });

    logger.info({ outcome: waveResult.outcome, reason: waveResult.stopReason }, "Wave execution finished");

    if (waveResult.outcome === "RATE_LIMITED_5H") {
      // Probe usage again to observe consumed delta
      const postUsage = await adapter.probeUsage();
      if (
        usage.weeklyUsedPct !== null &&
        postUsage.weeklyUsedPct !== null &&
        postUsage.weeklyUsedPct > usage.weeklyUsedPct
      ) {
        calibrationEngine.recordObservedWave({
          provider: globalConfig.provider,
          weeklyPctBefore: usage.weeklyUsedPct,
          weeklyPctAfter: postUsage.weeklyUsedPct,
          emaAlpha: globalConfig.calibration.ema_alpha
        });
      }

      const nextWake = postUsage.window5hResetAt
        ? new Date(postUsage.window5hResetAt.getTime() + 2 * 60_000)
        : new Date(Date.now() + 5 * 3600_000 + 2 * 60_000);

      updateActiveProject({
        status: "waiting_window_reset",
        nextWakeAt: nextWake.toISOString()
      });
    } else if (
      waveResult.outcome === "RATE_LIMITED_WEEKLY" ||
      waveResult.outcome === "HARD_STOP_REACHED" ||
      waveResult.outcome === "COMPLETED"
    ) {
      updateActiveProject({
        status: "completed_cycle",
        nextWakeAt: null
      });
    }

    return {
      executed: true,
      action: waveResult.outcome,
      reason: waveResult.stopReason
    };
  } catch (err: any) {
    logger.error({ err }, "Error during wave execution");
    updateActiveProject({
      lastRunError: err?.message || String(err),
      status: "armed"
    });
    return {
      executed: false,
      action: "ERROR",
      reason: err?.message || String(err)
    };
  } finally {
    const finalState = loadMachineState();
    finalState.activeRunPid = null;
    saveMachineState(finalState);
  }
}
