#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { loadConfig, autoDetectQualityGates, loadBacklog } from "./config/loader.js";
import { Orchestrator } from "./core/orchestrator.js";
import { GitManager } from "./git/git-manager.js";
import { QuotaGuard } from "./telemetry/quota-guard.js";
import { Reporter } from "./telemetry/reporter.js";
import { logger } from "./utils/logger.js";

const program = new Command();

program
  .name("wqb")
  .description("Weekend Quota Burner & Autonomous Codebase Auditor")
  .version("0.1.0");

// 1. wqb init
program
  .command("init")
  .description("Initialize wqb configuration and auto-detect project quality gates")
  .action(() => {
    const root = process.cwd();
    const configPath = path.join(root, "wqb.config.yaml");

    const gates = autoDetectQualityGates(root);
    logger.info({ gates }, "Auto-detected quality gates");

    const sampleConfig = {
      project: {
        root: ".",
        base_branch: "main",
        audit_branch_prefix: "ai-weekend-audit",
        worktree_dir: ".wqb/worktrees",
        max_parallel_workers: 2
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
      routing: {
        claude_categories: ["bug", "race_condition", "memory_leak", "security", "edge_case"],
        agy_categories: ["test_coverage", "tech_debt", "typing_lint"],
        agy_fallback_to_claude: true
      },
      quality_gates: {
        auto_detect: false,
        commands: gates,
        gate_timeout_sec: 120
      },
      agy: {
        binary: "agy",
        use_pty: true,
        disable_slow_mcp: true,
        extra_args: ["--output-format", "json"]
      },
      claude: {
        binary: "claude",
        model: "sonnet",
        audit_model: "opus"
      }
    };

    fs.writeFileSync(configPath, yaml.stringify(sampleConfig), "utf-8");
    logger.info({ configPath }, "Generated wqb.config.yaml");

    // Ensure .wqb/ is in .gitignore
    const gitignorePath = path.join(root, ".gitignore");
    let gitignore = "";
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignore.includes(".wqb")) {
      fs.appendFileSync(gitignorePath, "\n.wqb/\n", "utf-8");
      logger.info("Added .wqb/ to .gitignore");
    }

    console.log("✓ Successfully initialized wqb configuration.");
  });

// 2. wqb audit
program
  .command("audit")
  .description("Run Phase 1 read-only codebase audit and generate backlog")
  .option("--max-tasks <number>", "Maximum number of audit tasks to generate", parseInt)
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const orchestrator = new Orchestrator(config);
      const backlog = await orchestrator.runAudit(opts.maxTasks);

      console.log("\n--- Generated Backlog ---");
      console.table(
        backlog.tasks.map((t) => ({
          ID: t.id,
          Severity: t.severity,
          Category: t.category,
          Agent: t.assigned_agent,
          Title: t.title
        }))
      );
    } catch (err: any) {
      console.error("Audit failed:", err.message);
      process.exit(1);
    }
  });

// 3. wqb run
program
  .command("run")
  .description("Execute autonomous audit and fix pipeline")
  .option("--dry-run", "Verify plan without executing tasks in worktrees")
  .option("--workers <number>", "Number of parallel workers", parseInt)
  .option("--max-budget <usd>", "Max budget in USD", parseFloat)
  .option("--resume", "Resume existing session from .wqb/tasks.json")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      if (opts.maxBudget) {
        config.limits.claude_max_session_budget_usd = opts.maxBudget;
      }
      const orchestrator = new Orchestrator(config);
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

// 4. wqb status
program
  .command("status")
  .description("Show backlog status, telemetry burn-rate, and circuit breaker")
  .action(() => {
    const config = loadConfig();
    const tasksPath = path.join(".wqb", "tasks.json");
    const backlog = loadBacklog(tasksPath);

    console.log("\n=== WQB Status ===");
    if (!backlog) {
      console.log("No active backlog found at .wqb/tasks.json. Run 'wqb audit' or 'wqb run' first.");
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

    const quotaGuard = new QuotaGuard({
      claudeMaxSessionBudgetUsd: config.limits.claude_max_session_budget_usd,
      stopAtFiveHourQuotaPct: config.limits.stop_at_five_hour_quota_pct,
      stopAtWeeklyQuotaPct: config.limits.stop_at_weekly_quota_pct
    });

    const usage = quotaGuard.scanLogs();
    console.log("\n=== Quota & Burn Rate ===");
    console.log(`- Session Cost: $${usage.sessionCostUsd.toFixed(2)} USD (Budget: $${config.limits.claude_max_session_budget_usd.toFixed(2)})`);
    console.log(`- 5-Hour Window Cost: $${usage.cost5hUsd.toFixed(2)} USD (${usage.tokens5h} tokens)`);
    console.log(`- 7-Day Window Cost: $${usage.cost7dUsd.toFixed(2)} USD (${usage.tokens7d} tokens)`);
  });

// 5. wqb report
program
  .command("report")
  .description("Generate and output final markdown report")
  .action(() => {
    const tasksPath = path.join(".wqb", "tasks.json");
    const backlog = loadBacklog(tasksPath);
    if (!backlog) {
      console.error("No backlog found at .wqb/tasks.json");
      process.exit(1);
    }

    const reportPath = Reporter.saveReport({
      auditBranch: backlog.audit_branch,
      durationMs: 0,
      stopReason: "Manual report request",
      backlog
    });

    console.log(`✓ Report generated: ${reportPath}`);
    const content = fs.readFileSync(reportPath, "utf-8");
    console.log("\n" + content);
  });

// 6. wqb cleanup
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
