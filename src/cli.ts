#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { loadConfig, autoDetectQualityGates, loadBacklog, getWetDir } from "./config/loader.js";
import { Orchestrator } from "./core/orchestrator.js";
import { GitManager } from "./git/git-manager.js";
import { QuotaGuard } from "./telemetry/quota-guard.js";
import { Reporter } from "./telemetry/reporter.js";
import { logger } from "./utils/logger.js";
import { runInteractiveMenu } from "./ui/interactive-menu.js";
import { runWatchTick } from "./scheduler/watcher.js";
import {
  armProject,
  disarmProject,
  loadGlobalConfig,
  loadMachineState
} from "./config/global-store.js";
import { getAdapter } from "./adapters/registry.js";
import { CalibrationEngine } from "./scheduler/calibration-engine.js";
import { computeExecutionPlan } from "./scheduler/wave-planner.js";
import { classifyTopology, synthesizeFallbackBuckets } from "./scheduler/quota-topology.js";
import {
  installBackgroundWatcher,
  uninstallBackgroundWatcher,
  getWatcherStatus
} from "./scheduler/service-installer.js";
import {
  formatWaveTimelineTable,
  formatUsageReport
} from "./ui/formatters.js";

const program = new Command();

program
  .name("wet")
  .description("WorthEveryToken (wet) v2.3.0 — Autonomous Multi-Cycle Token Burner & Quota Optimizer")
  .version("2.3.0");

// 1. Interactive TUI default when no args are passed
if (process.argv.length <= 2) {
  runInteractiveMenu().catch((err) => {
    logger.error({ err }, "Fatal error in interactive menu");
    console.error("Fatal error:", err?.message || String(err));
    process.exit(1);
  });
} else {
  // wet watch
  program
    .command("watch")
    .description("Execute one background watcher tick (designed for systemd timer or cron)")
    .action(async () => {
      try {
        const result = await runWatchTick();
        logger.info(result, "Watch tick completed");
      } catch (err: any) {
        logger.error({ err }, "Watch tick failed");
        console.error("Watch tick error:", err.message);
        process.exit(1);
      }
    });

  // wet arm [--force]
  program
    .command("arm")
    .description("Schedule the current repository for autonomous pre-reset wave execution")
    .option("-f, --force", "Force replace existing active project if another repository is armed")
    .action((opts) => {
      const cwd = process.cwd();
      const isGit = fs.existsSync(path.join(cwd, ".git"));
      if (!isGit) {
        console.error("Error: Current directory is not a Git repository.");
        process.exit(1);
      }

      const res = armProject(cwd, { forceReplace: Boolean(opts.force) });
      if (res.conflict && res.existingProject) {
        console.error(
          `Conflict: Project "${res.existingProject.repoName}" (${res.existingProject.repoPath}) is already armed.\nUse 'wet arm --force' to replace it, or run 'wet disarm' first.`
        );
        process.exit(1);
      }

      console.log(`✓ Successfully armed project: ${res.activeProject?.repoName ?? path.basename(cwd)}`);
      console.log(`  Path: ${res.activeProject?.repoPath ?? cwd}`);
    });

  // wet disarm
  program
    .command("disarm")
    .description("Cancel scheduled execution for the currently armed project")
    .action(() => {
      const disarmed = disarmProject();
      if (disarmed) {
        console.log(`✓ Disarmed project: ${disarmed.repoName} (${disarmed.repoPath})`);
      } else {
        console.log("No project was currently armed.");
      }
    });

  // wet probe
  program
    .command("probe")
    .description("Interrogate active provider CLI for usage, reset timestamps, and computed wave plan")
    .action(async () => {
      try {
        const globalConfig = loadGlobalConfig();
        const adapter = getAdapter(globalConfig.provider, globalConfig);
        const topModel = adapter.getTopModelProfile(globalConfig);
        const usage = await adapter.probeUsage();

        const calibEngine = new CalibrationEngine();
        const { rate: weeklyPctPer5hWave, source } = calibEngine.getRateForProvider(
          globalConfig.provider,
          globalConfig.subscription_tier
        );

        const now = new Date();
        const machineState = loadMachineState();
        const effectiveBuckets =
          usage.buckets.length > 0
            ? usage.buckets
            : synthesizeFallbackBuckets(globalConfig, now, machineState);
        const topology = classifyTopology(effectiveBuckets);
        const plan = computeExecutionPlan({
          topology,
          calibration: {
            primaryPctPerSubWindow: weeklyPctPer5hWave
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

        const displayUsage = {
          ...usage,
          buckets: effectiveBuckets,
          weeklyResetAt:
            usage.weeklyResetAt ??
            (topology.primaryBucket?.resetAt ? new Date(topology.primaryBucket.resetAt) : null)
        };

        console.log("\n" + formatUsageReport(displayUsage));
        console.log(`\n• Detected topology: ${topology.type}`);
        console.log(`• Rate/window calibration: ${weeklyPctPer5hWave}% (source: ${source})`);
        console.log(`• Detected top model: ${topModel.model}`);
        if (plan.selectedModel) {
          console.log(`• Selected model in cascade: ${plan.selectedModel}`);
        }
        if (plan.action === "FAIL_CLOSED_UNKNOWN_RESET") {
          console.log(`\n⚠️  FAIL-CLOSED ACTIVE: ${plan.summary}`);
          console.log("   No tokens will be burned until the reset timestamp is authoritatively known.\n");
        } else {
          console.log("\n" + formatWaveTimelineTable(plan) + "\n");
        }
      } catch (err: any) {
        console.error("Probe error:", err.message);
        process.exit(1);
      }
    });

  // wet service <install|uninstall|status>
  program
    .command("service <action>")
    .description("Manage system background watcher service (systemd timer on Linux or cron fallback)")
    .action(async (action) => {
      if (action === "install") {
        const res = await installBackgroundWatcher();
        console.log(`✓ ${res.message}`);
        if (res.lingerWarning) {
          console.log(`\n${res.lingerWarning}`);
        }
      } else if (action === "uninstall") {
        const res = await uninstallBackgroundWatcher();
        console.log(`✓ ${res.message}`);
      } else if (action === "status") {
        const status = await getWatcherStatus();
        console.log(`Status: ${status.details} (Installed: ${status.installed}, Active: ${status.active ?? false})`);
      } else {
        console.error(`Unknown service action: ${action}. Use 'install', 'uninstall', or 'status'.`);
        process.exit(1);
      }
    });

  // wet init
  program
    .command("init")
    .description("Initialize WorthEveryToken configuration and auto-detect project quality gates")
    .action(() => {
      const root = process.cwd();
      const configPath = path.join(root, "wet.config.yaml");

      const gates = autoDetectQualityGates(root);
      logger.info({ gates }, "Auto-detected quality gates");

      const sampleConfig = {
        project: {
          root: ".",
          base_branch: "main",
          audit_branch_prefix: "ai-weekend-audit",
          worktree_dir: ".wet/worktrees",
          max_parallel_workers: 1
        },
        limits: {
          max_total_tasks: 25,
          max_retries_per_task: 3,
          max_consecutive_failures: 3,
          claude_max_turns_per_task: 18,
          claude_max_budget_usd_per_task: 2.5,
          claude_max_session_budget_usd: 25.0,
          stop_at_five_hour_quota_pct: 90,
          stop_at_weekly_quota_pct: 95,
          agy_wall_clock_timeout_sec: 180,
          agy_silence_watchdog_sec: 60
        },
        quality_gates: {
          auto_detect: false,
          commands: gates,
          gate_timeout_sec: 120
        }
      };

      fs.writeFileSync(configPath, yaml.stringify(sampleConfig), "utf-8");
      logger.info({ configPath }, "Generated wet.config.yaml");

      const gitignorePath = path.join(root, ".gitignore");
      let gitignore = "";
      if (fs.existsSync(gitignorePath)) {
        gitignore = fs.readFileSync(gitignorePath, "utf-8");
      }
      if (!gitignore.includes(".wet")) {
        fs.appendFileSync(gitignorePath, "\n.wet/\n", "utf-8");
        logger.info("Added .wet/ to .gitignore");
      }

      console.log("✓ Successfully initialized WorthEveryToken (wet) configuration.");
    });

  // wet audit
  program
    .command("audit")
    .description("Run Phase 1 read-only codebase audit and generate backlog")
    .option("--max-tasks <number>", "Maximum number of audit tasks to generate", parseInt)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const globalConfig = loadGlobalConfig();
        const adapter = getAdapter(globalConfig.provider, globalConfig);
        const orchestrator = new Orchestrator(config, adapter);
        const backlog = await orchestrator.runAudit(opts.maxTasks);

        console.log("\n--- Generated Backlog ---");
        console.table(
          backlog.tasks.map((t) => ({
            ID: t.id,
            Severity: t.severity,
            Category: t.category,
            Provider: adapter.provider,
            Title: t.title
          }))
        );
      } catch (err: any) {
        console.error("Audit failed:", err.message);
        process.exit(1);
      }
    });

  // wet run
  program
    .command("run")
    .description("Execute autonomous audit and fix pipeline")
    .option("--dry-run", "Verify plan without executing tasks in worktrees")
    .option("--workers <number>", "Number of parallel workers", parseInt)
    .option("--max-budget <usd>", "Max budget in USD", parseFloat)
    .option("--resume", "Resume existing session from .wet/tasks.json")
    .action(async (opts) => {
      try {
        const config = loadConfig();
        if (opts.maxBudget) {
          config.limits.claude_max_session_budget_usd = opts.maxBudget;
        }
        const globalConfig = loadGlobalConfig();
        const adapter = getAdapter(globalConfig.provider, globalConfig);
        const orchestrator = new Orchestrator(config, adapter);
        await orchestrator.run({
          dryRun: opts.dryRun,
          workers: opts.workers,
          maxBudget: opts.maxBudget,
          resume: opts.resume
        });
      } catch (err: any) {
        console.error("Execution error:", err.message);
        process.exit(1);
      }
    });

  // wet status
  program
    .command("status")
    .description("Show backlog status, telemetry burn-rate, and circuit breaker")
    .action(() => {
      const config = loadConfig();
      const globalConfig = loadGlobalConfig();
      const machineState = loadMachineState();
      const wetDir = getWetDir(config.project.root);
      const tasksPath = path.join(wetDir, "tasks.json");
      const backlog = loadBacklog(tasksPath);

      console.log("\n=== WorthEveryToken (wet) Status ===");
      console.log(`Active Provider: ${globalConfig.provider}`);
      if (machineState.activeProject) {
        console.log(`Scheduled Project: ${machineState.activeProject.repoName} (${machineState.activeProject.status})`);
      } else {
        console.log("Scheduled Project: None");
      }

      if (!backlog) {
        console.log(`No active backlog found at ${tasksPath}. Run 'wet audit' or 'wet run' first.`);
      } else {
        const summary = {
          total: backlog.tasks.length,
          pending: backlog.tasks.filter((t) => t.status === "pending").length,
          in_progress: backlog.tasks.filter((t) => t.status === "in_progress").length,
          completed: backlog.tasks.filter((t) => t.status === "completed").length,
          failed: backlog.tasks.filter((t) => t.status === "failed").length,
          skipped: backlog.tasks.filter((t) => t.status === "skipped").length
        };
        console.table([summary]);
      }

      const quotaGuard = new QuotaGuard(
        {
          claudeMaxSessionBudgetUsd: config.limits.claude_max_session_budget_usd,
          stopAtFiveHourQuotaPct: config.limits.stop_at_five_hour_quota_pct,
          stopAtWeeklyQuotaPct: config.limits.stop_at_weekly_quota_pct
        },
        path.join(wetDir, "quota-state.json")
      );

      const usage = quotaGuard.scanLogs();
      console.log("\n=== Quota & Burn Rate ===");
      console.log(`- Session Cost: $${usage.sessionCostUsd.toFixed(2)} USD (Budget: $${config.limits.claude_max_session_budget_usd.toFixed(2)})`);
      console.log(`- 5-Hour Window Cost: $${usage.cost5hUsd.toFixed(2)} USD (${usage.tokens5h} tokens)`);
      console.log(`- 7-Day Window Cost: $${usage.cost7dUsd.toFixed(2)} USD (${usage.tokens7d} tokens)`);
    });

  // wet report
  program
    .command("report")
    .description("Generate and output final markdown report")
    .action(() => {
      const config = loadConfig();
      const wetDir = getWetDir(config.project.root);
      const tasksPath = path.join(wetDir, "tasks.json");
      const backlog = loadBacklog(tasksPath);
      if (!backlog) {
        console.error(`No backlog found at ${tasksPath}`);
        process.exit(1);
      }

      const reportPath = Reporter.saveReport(
        {
          auditBranch: backlog.audit_branch,
          durationMs: 0,
          stopReason: "Manual report request",
          backlog
        },
        wetDir
      );

      console.log(`✓ Report generated: ${reportPath}`);
      const content = fs.readFileSync(reportPath, "utf-8");
      console.log("\n" + content);
    });

  // wet cleanup
  program
    .command("cleanup")
    .description("Clean up orphan worktrees and temporary branches")
    .action(async () => {
      const config = loadConfig();
      const gitManager = new GitManager({
        repoRoot: config.project.root,
        baseBranch: config.project.base_branch,
        auditBranchPrefix: config.project.audit_branch_prefix,
        worktreeDir: config.project.worktree_dir
      });

      await gitManager.cleanupAll();
      console.log("✓ Successfully cleaned up worktrees and temporary branches.");
    });

  program.parse(process.argv);
}
