import fs from "node:fs";
import {
  loadGlobalConfig,
  loadMachineState,
  saveMachineState,
  updateActiveProject
} from "../config/global-store.js";
import { getAdapter } from "../adapters/registry.js";
import { CalibrationEngine } from "./calibration-engine.js";
import { computeExecutionPlan } from "./wave-planner.js";
import { classifyTopology } from "./quota-topology.js";
import { CycleGuard } from "./cycle-guard.js";
import { checkUserActivity } from "./activity-guard.js";
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
  const now = new Date();

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

  // 3. Silent auto-renewal: if completed_cycle and lockedCycleResetAt + 30m has passed, auto-arm for next cycle
  if (activeProject.status === "completed_cycle") {
    if (activeProject.lockedCycleResetAt) {
      const renewTime = new Date(activeProject.lockedCycleResetAt).getTime() + 30 * 60_000;
      if (now.getTime() >= renewTime) {
        logger.info(
          { project: activeProject.repoName },
          "Cycle reset passed by +30m. Silently auto-renewing project to 'armed' for new cycle."
        );
        updateActiveProject({
          status: "armed",
          lockedCycleResetAt: null,
          cyclePeakUsedPct: null,
          auditPassCount: 0,
          nextWakeAt: null
        });
        activeProject.status = "armed";
      } else {
        return {
          executed: false,
          action: "CYCLE_COMPLETED",
          reason: "Cycle completed. Standing by until new cycle starts."
        };
      }
    } else {
      return {
        executed: false,
        action: "CYCLE_COMPLETED",
        reason: "Cycle completed."
      };
    }
  }

  // 4. Guard: check if an active run PID is already alive
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

  // 5. Instantiate universal adapter and probe usage
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  logger.info({ provider: globalConfig.provider }, "Probing provider usage for scheduled wave check...");

  const usage = await adapter.probeUsage();

  // Record usage snapshot in machine state
  machineState.lastKnownUsage = {
    provider: usage.provider,
    probedAt: usage.probedAt.toISOString(),
    source: usage.source,
    buckets: usage.buckets,
    weeklyUsedPct: usage.weeklyUsedPct,
    weeklyResetAt: usage.weeklyResetAt ? usage.weeklyResetAt.toISOString() : null,
    window5hUsedPct: usage.window5hUsedPct,
    window5hResetAt: usage.window5hResetAt ? usage.window5hResetAt.toISOString() : null,
    detectedModel: usage.detectedModel
  };

  // Determine fallback weekly reset if missing
  let weeklyResetAt = usage.weeklyResetAt;
  if (!weeklyResetAt) {
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

  // Classify topology
  const topology = classifyTopology(usage.buckets);

  // 6. Early reset check (Level 3 Zero-Bleed Guard)
  const currentResetAt = topology.primaryBucket?.resetAt
    ? new Date(topology.primaryBucket.resetAt)
    : (usage.weeklyResetAt ?? null);
  const currentUsedPct = topology.primaryBucket?.usedPct ?? usage.weeklyUsedPct ?? null;

  const earlyReset = CycleGuard.checkEarlyReset({
    lockedCycleResetAt: activeProject.lockedCycleResetAt ? new Date(activeProject.lockedCycleResetAt) : null,
    cyclePeakUsedPct: activeProject.cyclePeakUsedPct,
    currentResetAt,
    currentUsedPct,
    now
  });

  if (earlyReset.abort) {
    logger.warn({ reason: earlyReset.reason }, "Early cycle reset detected! Halting wave execution.");
    updateActiveProject({
      status: "completed_cycle",
      nextWakeAt: null
    });
    return { executed: false, action: "EARLY_RESET_DETECTED_ABORT", reason: earlyReset.reason ?? "Early reset" };
  }

  // 7. User Activity Guard (Fase 4.1)
  let hoursUntilReset: number | null = null;
  if (currentResetAt) {
    hoursUntilReset = Math.max(0, (currentResetAt.getTime() - now.getTime()) / 3600_000);
  }

  const activity = await checkUserActivity(activeProject.repoPath, globalConfig.provider, globalConfig, hoursUntilReset);
  if (activity.active) {
    logger.info({ reason: activity.reason }, "User activity detected. Yielding execution quietly.");
    updateActiveProject({
      status: "yielded_to_user"
    });
    return { executed: false, action: "YIELDED_TO_USER", reason: activity.reason ?? "User active" };
  }

  // 8. Calibration & Execution Plan
  const calibrationEngine = new CalibrationEngine();
  if (globalConfig.calibration.sync_external_benchmarks) {
    await calibrationEngine.syncExternalBenchmarks(
      globalConfig.calibration.benchmark_source_url,
      globalConfig.calibration.benchmark_cache_ttl_hours
    );
  }

  const { rate: primaryPctPerSubWindow } = calibrationEngine.getRateForProvider(
    globalConfig.provider,
    globalConfig.subscription_tier
  );

  const plan = computeExecutionPlan({
    topology,
    calibration: {
      primaryPctPerSubWindow,
      primaryPctPerHour: 4
    },
    config: {
      targetWeeklyBurnPct: globalConfig.schedule.target_weekly_burn_pct,
      windowHours: globalConfig.schedule.window_hours,
      waveBufferMinutes: globalConfig.schedule.wave_buffer_minutes,
      hardStopBeforeResetMinutes: globalConfig.schedule.hard_stop_before_reset_minutes,
      minTaskReserveMinutes: globalConfig.schedule.min_task_reserve_minutes,
      quietHours: globalConfig.schedule.quiet_hours
    },
    now
  });

  logger.info(
    { action: plan.action, wavesNeeded: plan.wavesNeeded, summary: plan.summary, topology: topology.type },
    "Adaptive execution plan assessment"
  );

  // Level 5 Fail-Closed handling
  if (plan.action === "FAIL_CLOSED_UNKNOWN_RESET") {
    logger.warn({ summary: plan.summary }, "Fail-closed enforced: standing by without burning tokens");
    return { executed: false, action: "FAIL_CLOSED_UNKNOWN_RESET", reason: plan.summary };
  }

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
  logger.info({ project: activeProject.repoPath, model: plan.selectedModel }, "Starting scheduled wave execution!");
  machineState.activeRunPid = process.pid;
  saveMachineState(machineState);

  const lockedResetAt = activeProject.lockedCycleResetAt ?? (currentResetAt ? currentResetAt.toISOString() : null);
  const newPeakPct = Math.max(activeProject.cyclePeakUsedPct ?? 0, currentUsedPct ?? 0);

  updateActiveProject({
    status: "running_wave",
    lastWaveStartedAt: new Date().toISOString(),
    lastWaveWeeklyPctBefore: usage.weeklyUsedPct,
    lockedCycleResetAt: lockedResetAt,
    cyclePeakUsedPct: newPeakPct
  });

  try {
    if (!fs.existsSync(activeProject.repoPath)) {
      throw new Error(`Repository path does not exist: ${activeProject.repoPath}`);
    }

    const wetConfig = loadConfig(activeProject.repoPath);
    const orchestrator = new Orchestrator(wetConfig, adapter);

    const waveResult = await orchestrator.runWave({
      hardStopAt: plan.hardStopAt,
      selectedModel: plan.selectedModel,
      resume: true,
      onBeforeTaskCheck: async () => {
        const checkNow = new Date();
        // 1. Level 1: Hard stop fit check
        const fit = CycleGuard.canStartNextTask({
          now: checkNow,
          hardStopAt: plan.hardStopAt,
          minTaskReserveMinutes: globalConfig.schedule.min_task_reserve_minutes
        });
        if (!fit.allowed) {
          return { allowed: false, reason: fit.reason };
        }

        // 2. Level 3: Early reset check
        if (lockedResetAt) {
          const early = CycleGuard.checkEarlyReset({
            lockedCycleResetAt: new Date(lockedResetAt),
            cyclePeakUsedPct: newPeakPct,
            currentResetAt,
            currentUsedPct,
            now: checkNow
          });
          if (early.abort) {
            return { allowed: false, reason: early.reason };
          }
        }

        // 3. User activity guard (ignore AI logs during wave execution to avoid self-yield)
        const activity = await checkUserActivity(
          activeProject.repoPath,
          globalConfig.provider,
          globalConfig,
          hoursUntilReset,
          { ignoreAiLogs: true }
        );
        if (activity.active) {
          return { allowed: false, reason: `YIELDED_TO_USER: ${activity.reason}` };
        }

        return { allowed: true };
      }
    });

    logger.info({ outcome: waveResult.outcome, reason: waveResult.stopReason }, "Wave execution finished");

    if (waveResult.outcome === "YIELDED_TO_USER") {
      updateActiveProject({
        status: "yielded_to_user",
        nextWakeAt: new Date(Date.now() + 15 * 60_000).toISOString()
      });
    } else if (waveResult.outcome === "EARLY_RESET_DETECTED") {
      updateActiveProject({
        status: "completed_cycle",
        nextWakeAt: null
      });
    } else if (waveResult.outcome === "RATE_LIMITED_5H") {
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

      // Level 4 Defense: Check if next wake straddles hard stop
      if (!CycleGuard.shouldScheduleWakeup(nextWake, plan.hardStopAt)) {
        updateActiveProject({
          status: "completed_cycle",
          nextWakeAt: null
        });
      } else {
        updateActiveProject({
          status: "waiting_window_reset",
          nextWakeAt: nextWake.toISOString()
        });
      }
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
