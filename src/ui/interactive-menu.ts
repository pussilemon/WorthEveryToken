import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  hasGlobalConfig,
  loadGlobalConfig,
  saveGlobalConfig,
  loadMachineState,
  armProject,
  disarmProject,
  updateLastKnownUsage
} from "../config/global-store.js";
import { type ProviderId, type WetGlobalConfig } from "../config/schema.js";
import { getAdapter } from "../adapters/registry.js";
import type { UsageSnapshot } from "../adapters/agent-adapter.js";
import { CalibrationEngine } from "../scheduler/calibration-engine.js";
import { computeExecutionPlan } from "../scheduler/wave-planner.js";
import { classifyTopology } from "../scheduler/quota-topology.js";
import {
  installBackgroundWatcher,
  uninstallBackgroundWatcher,
  getWatcherStatus
} from "../scheduler/service-installer.js";
import {
  formatHeaderBanner,
  formatWaveTimelineTable,
  formatUsageReport,
  formatTopologyLabel
} from "./formatters.js";
import { autoDetectQualityGates, loadConfig } from "../config/loader.js";
import { Orchestrator } from "../core/orchestrator.js";

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execa(cmd, ["--version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function runFirstRunWizard(): Promise<WetGlobalConfig> {
  p.intro(pc.bold(pc.cyan("Welcome to WorthEveryToken (wet) v2.2.1 — Initial Setup")));

  const s = p.spinner();
  s.start("Detecting installed AI CLIs in PATH...");

  const [hasClaude, hasCodex, hasAgy, hasGemini] = await Promise.all([
    isCommandAvailable("claude"),
    isCommandAvailable("codex"),
    isCommandAvailable("agy"),
    isCommandAvailable("gemini")
  ]);

  s.stop("Detection complete.");

  const providerOptions = [
    {
      value: "claude" as ProviderId,
      label: `Anthropic Claude Code ${hasClaude ? pc.green("(installed ✓)") : pc.dim("(not found)")}`,
      hint: "Recommended for Opus and Claude Pro/Max subscriptions"
    },
    {
      value: "codex" as ProviderId,
      label: `OpenAI Codex CLI ${hasCodex ? pc.green("(installed ✓)") : pc.dim("(not found)")}`,
      hint: "Recommended for o3-mini and OpenAI Plus/Pro subscriptions"
    },
    {
      value: "agy" as ProviderId,
      label: `Google Antigravity CLI (agy) ${hasAgy ? pc.green("(installed ✓)") : pc.dim("(not found)")}`,
      hint: "Recommended for Google Agy Pro subscriptions"
    },
    {
      value: "gemini" as ProviderId,
      label: `Google Gemini CLI ${hasGemini ? pc.green("(installed ✓)") : pc.dim("(not found)")}`,
      hint: "Recommended for Gemini 2.5 Pro / Flash"
    },
    {
      value: "custom" as ProviderId,
      label: "Custom Provider (generic external CLI)",
      hint: "Configurable with custom CLI commands"
    }
  ];

  // Step 1: Choose single active provider
  const defaultProvider = hasClaude ? "claude" : hasCodex ? "codex" : hasAgy ? "agy" : hasGemini ? "gemini" : "claude";

  const selectedProvider = await p.select({
    message: "Step 1/3 — Choose the active AI subscription to optimize:",
    options: providerOptions,
    initialValue: defaultProvider
  });

  if (p.isCancel(selectedProvider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const globalConfig = loadGlobalConfig();
  globalConfig.provider = selectedProvider as ProviderId;

  // Step 2: Auto-detect live quota and topology
  s.start(`Step 2/3 — Detecting quota, buckets, and topology for ${selectedProvider}...`);
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  const usage = await adapter.probeUsage();
  s.stop("Live detection complete.");

  updateLastKnownUsage({
    provider: usage.provider,
    probedAt: usage.probedAt.toISOString(),
    source: usage.source,
    buckets: usage.buckets,
    weeklyUsedPct: usage.weeklyUsedPct,
    weeklyResetAt: usage.weeklyResetAt ? usage.weeklyResetAt.toISOString() : null,
    window5hUsedPct: usage.window5hUsedPct,
    window5hResetAt: usage.window5hResetAt ? usage.window5hResetAt.toISOString() : null,
    detectedModel: usage.detectedModel ?? null
  });

  const topology = classifyTopology(usage.buckets);
  const topologyLabel = formatTopologyLabel(topology.type);

  if (usage.weeklyResetAt && usage.weeklyUsedPct !== null) {
    p.note(
      `Topology: ${pc.magenta(topologyLabel)}\nDetected reset: ${pc.cyan(usage.weeklyResetAt.toLocaleString())}\nQuota used: ${pc.yellow(`${usage.weeklyUsedPct}%`)} (remaining ${(100 - usage.weeklyUsedPct).toFixed(0)}%)`,
      "Topology and Quota detected successfully ✓"
    );
  } else {
    p.note(
      `Topology: ${pc.magenta(topologyLabel)}\nCLI did not report an exact reset timestamp. Fallback schedule will apply (Monday 08:00).`,
      "Fallback Schedule Configured"
    );
  }

  // Step 3: Background invisible mode
  const installWatcher = await p.confirm({
    message: "Step 3/3 — Enable Invisible Background Mode (systemd/cron + Zero-Touch Git)?",
    initialValue: true
  });

  if (p.isCancel(installWatcher)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  saveGlobalConfig(globalConfig);

  if (installWatcher) {
    s.start("Installing background watcher...");
    const res = await installBackgroundWatcher();
    s.stop(res.message);
    if (res.lingerWarning) {
      p.note(res.lingerWarning, "Notice for SSH Sessions");
    }

    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, ".git"))) {
      armProject(cwd, { forceReplace: true });
      p.note(`Current directory "${path.basename(cwd)}" automatically armed in invisible mode!`, "Project Armed");
    }
  }

  p.outro(pc.green("WorthEveryToken v2.2.1 configured successfully!"));
  return globalConfig;
}

export async function runInteractiveMenu(): Promise<void> {
  if (!hasGlobalConfig()) {
    await runFirstRunWizard();
  }

  const globalConfig = loadGlobalConfig();
  const machineState = loadMachineState();
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  const topModel = adapter.getTopModelProfile(globalConfig);
  const watcherStatus = await getWatcherStatus();

  // Try quick probe for display
  const usage: UsageSnapshot | null = machineState.lastKnownUsage
    ? {
        provider: machineState.lastKnownUsage.provider,
        probedAt: new Date(machineState.lastKnownUsage.probedAt),
        source: machineState.lastKnownUsage.source,
        buckets: machineState.lastKnownUsage.buckets ?? [],
        weeklyUsedPct: machineState.lastKnownUsage.weeklyUsedPct ?? null,
        weeklyResetAt: machineState.lastKnownUsage.weeklyResetAt ? new Date(machineState.lastKnownUsage.weeklyResetAt) : null,
        window5hUsedPct: machineState.lastKnownUsage.window5hUsedPct ?? null,
        window5hResetAt: machineState.lastKnownUsage.window5hResetAt ? new Date(machineState.lastKnownUsage.window5hResetAt) : null,
        detectedModel: machineState.lastKnownUsage.detectedModel
      }
    : null;

  const calibEngine = new CalibrationEngine();
  const { rate: ratePer5h } = calibEngine.getRateForProvider(globalConfig.provider, globalConfig.subscription_tier);

  const now = new Date();
  const topology = classifyTopology(usage?.buckets ?? []);
  const plan = computeExecutionPlan({
    topology,
    calibration: {
      primaryPctPerSubWindow: ratePer5h
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

  // Display banner
  console.log(
    formatHeaderBanner({
      provider: globalConfig.provider,
      model: topModel.model,
      usage,
      activeProject: machineState.activeProject,
      watcher: watcherStatus,
      plan,
      topologyType: topology.type
    })
  );

  const cwd = process.cwd();
  const isGit = fs.existsSync(path.join(cwd, ".git"));

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      {
        value: "arm",
        label: "1. Arm / Schedule this repository for the next pre-reset cycle",
        hint: isGit ? cwd : "Warning: current directory is not a Git repository"
      },
      {
        value: "run_now",
        label: "2. Run an immediate session (Audit + Fix tasks on current project now)",
        hint: "Executes pipeline immediately without waiting for reset"
      },
      {
        value: "view_plan",
        label: "3. View Wave Plan & detailed status",
        hint: "Live 5h wave calculation, timeline, and calibration %"
      },
      {
        value: "view_report",
        label: "4. Open / Print latest generated Report",
        hint: ".wet/REPORT-*.md"
      },
      {
        value: "disarm",
        label: "5. Disarm / Cancel current scheduled project on this machine",
        hint: machineState.activeProject ? machineState.activeProject.repoName : "None armed"
      },
      {
        value: "settings",
        label: "6. Settings (Change provider, background watcher, sync benchmarks)",
        hint: "Configure ~/.wet/config.yaml"
      },
      {
        value: "exit",
        label: "7. Exit",
        hint: "Quit menu"
      }
    ]
  });

  if (p.isCancel(action) || action === "exit") {
    p.outro("Goodbye!");
    return;
  }

  switch (action) {
    case "arm": {
      if (!isGit) {
        p.note("Current directory is not a Git repository. Navigate to a Git repo before arming.", "Error");
        return;
      }

      const armResult = armProject(cwd, { forceReplace: false });
      if (armResult.conflict && armResult.existingProject) {
        const replace = await p.confirm({
          message: `The active project is currently "${armResult.existingProject.repoName}" (${armResult.existingProject.repoPath}).\nDo you want to disarm it and schedule this directory?`,
          initialValue: false
        });

        if (!replace || p.isCancel(replace)) {
          p.outro("Previous schedule preserved unchanged.");
          return;
        }

        armProject(cwd, { forceReplace: true });
      }

      // Check quality gates
      const gates = autoDetectQualityGates(cwd);
      p.note(
        gates.map((g) => `• ${g.name}: ${g.cmd}`).join("\n"),
        "Quality gates automatically detected for this project"
      );

      // Ensure .gitignore has .wet
      const gitignorePath = path.join(cwd, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        if (!content.includes(".wet")) {
          fs.appendFileSync(gitignorePath, "\n.wet/\n");
        }
      }

      p.outro(pc.green(`Project ${path.basename(cwd)} armed successfully!`));
      break;
    }

    case "run_now": {
      p.intro(pc.cyan("Starting immediate session..."));
      const wetConfig = loadConfig(cwd);
      const orchestrator = new Orchestrator(wetConfig, adapter);
      await orchestrator.run({ resume: true });
      p.outro(pc.green("Session completed!"));
      break;
    }

    case "view_plan": {
      console.log("\n" + formatWaveTimelineTable(plan) + "\n");
      if (usage) {
        console.log(formatUsageReport(usage) + "\n");
      }
      p.outro("Plan displayed.");
      break;
    }

    case "view_report": {
      const wetDir = path.join(cwd, ".wet");
      if (!fs.existsSync(wetDir)) {
        p.note("No .wet directory found in this project.", "Info");
        return;
      }
      const files = fs.readdirSync(wetDir).filter((f) => f.startsWith("REPORT-") && f.endsWith(".md"));
      if (files.length === 0) {
        p.note("No generated report found in .wet/", "Info");
        return;
      }
      files.sort().reverse();
      const latest = path.join(wetDir, files[0]!);
      const content = fs.readFileSync(latest, "utf-8");
      console.log("\n" + content + "\n");
      p.outro(`Report displayed: ${files[0]}`);
      break;
    }

    case "disarm": {
      const disarmed = disarmProject();
      if (disarmed) {
        p.outro(pc.yellow(`Project ${disarmed.repoName} disarmed. No automated work queued.`));
      } else {
        p.outro("No project was armed.");
      }
      break;
    }

    case "settings": {
      const settingChoice = await p.select({
        message: "What would you like to configure?",
        options: [
          { value: "provider", label: "Change active provider" },
          { value: "watcher_install", label: "Reinstall background watcher" },
          { value: "watcher_uninstall", label: "Remove background watcher" },
          { value: "sync_benchmarks", label: "Synchronize external benchmarks now" }
        ]
      });

      if (p.isCancel(settingChoice)) return;

      if (settingChoice === "provider") {
        await runFirstRunWizard();
      } else if (settingChoice === "watcher_install") {
        const res = await installBackgroundWatcher();
        p.outro(res.message);
      } else if (settingChoice === "watcher_uninstall") {
        const res = await uninstallBackgroundWatcher();
        p.outro(res.message);
      } else if (settingChoice === "sync_benchmarks") {
        const s = p.spinner();
        s.start("Syncing benchmarks from aicodingdaily.com...");
        await calibEngine.syncExternalBenchmarks(globalConfig.calibration.benchmark_source_url, 0);
        s.stop("Synchronization complete.");
        p.outro("Cache updated.");
      }
      break;
    }
  }
}
