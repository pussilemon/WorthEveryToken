import fs from "node:fs";
import path from "node:path";
import { type WetConfig, type Backlog, type Task } from "../config/schema.js";
import { GitManager } from "../git/git-manager.js";
import { DagScheduler, type TaskExecutionOutcome } from "./dag-scheduler.js";
import { ClaudeAdapter } from "../adapters/claude-adapter.js";
import { AgyAdapter } from "../adapters/agy-adapter.js";
import { QualityGatesRunner } from "./quality-gates.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { QuotaGuard } from "../telemetry/quota-guard.js";
import { BurnProfiler } from "../telemetry/burn-profiler.js";
import { Reporter } from "../telemetry/reporter.js";
import { compilePrompt, loadBacklog, saveBacklog } from "../config/loader.js";
import { parseBacklogJson, parseFixPlanMd } from "../adapters/agent-adapter.js";
import { logger } from "../utils/logger.js";
import { execa } from "execa";

export interface OrchestratorRunOptions {
  dryRun?: boolean;
  workers?: number;
  maxBudget?: number;
  resume?: boolean;
}

export class Orchestrator {
  private readonly config: WetConfig;
  private readonly gitManager: GitManager;
  private readonly claudeAdapter: ClaudeAdapter;
  private readonly agyAdapter: AgyAdapter;
  private readonly qualityGatesRunner: QualityGatesRunner;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly quotaGuard: QuotaGuard;
  private readonly burnProfiler: BurnProfiler;
  private stopRequested = false;
  private stopReason = "Backlog completed";

  constructor(config: WetConfig) {
    this.config = config;
    this.gitManager = new GitManager({
      repoRoot: config.project.root,
      baseBranch: config.project.base_branch,
      auditBranchPrefix: config.project.audit_branch_prefix,
      worktreeDir: config.project.worktree_dir
    });

    this.claudeAdapter = new ClaudeAdapter({
      binary: config.claude.binary,
      defaultModel: config.claude.model
    });

    this.agyAdapter = new AgyAdapter({
      binary: config.agy.binary,
      usePty: config.agy.use_pty,
      disableSlowMcp: config.agy.disable_slow_mcp,
      extraArgs: config.agy.extra_args,
      wallClockTimeoutSec: config.limits.agy_wall_clock_timeout_sec,
      silenceWatchdogSec: config.limits.agy_silence_watchdog_sec
    });

    this.qualityGatesRunner = new QualityGatesRunner(
      config.quality_gates.commands,
      config.quality_gates.gate_timeout_sec
    );

    this.circuitBreaker = new CircuitBreaker({
      maxConsecutiveFailures: config.limits.max_consecutive_failures
    });

    this.quotaGuard = new QuotaGuard({
      claudeMaxSessionBudgetUsd: config.limits.claude_max_session_budget_usd,
      stopAtFiveHourQuotaPct: config.limits.stop_at_five_hour_quota_pct,
      stopAtWeeklyQuotaPct: config.limits.stop_at_weekly_quota_pct
    });

    this.burnProfiler = new BurnProfiler();
  }

  public async runAudit(maxTasks?: number): Promise<Backlog> {
    const max = maxTasks ?? this.config.limits.max_total_tasks;
    logger.info({ maxTasks: max }, "Starting Phase 1 Read-Only Codebase Audit");

    const auditPrompt = compilePrompt("prompts/phase1-audit.md", {
      REPO_PATH: path.resolve(this.config.project.root),
      MAX_TASKS: String(max)
    });

    const result = await this.claudeAdapter.execute(auditPrompt, {
      cwd: this.config.project.root,
      model: this.config.claude.audit_model,
      allowedTools: "Read,Glob,Grep"
    });

    if (result.status === "RATE_LIMITED") {
      throw new Error(`Claude Code is rate limited: ${result.rateLimitReset ?? "try again later"}`);
    }

    const parsedBacklog = parseBacklogJson(result.output);
    if (!parsedBacklog) {
      throw new Error("Phase 1 Audit did not return valid JSON in <WET_BACKLOG_JSON> tags");
    }

    // Save tasks.json
    const tasksPath = path.join(".wet", "tasks.json");
    saveBacklog(tasksPath, parsedBacklog);
    logger.info({ taskCount: parsedBacklog.tasks.length }, "Audit backlog saved to .wet/tasks.json");

    // Save fix_plan.md
    const fixPlanDir = path.join(".wet");
    fs.mkdirSync(fixPlanDir, { recursive: true });
    const fixPlanMd = parseFixPlanMd(result.output);
    const planContent =
      fixPlanMd ??
      `# WorthEveryToken Fix Plan\n\nGenerated: ${parsedBacklog.generated_at}\n\n` +
        parsedBacklog.tasks
          .map((t) => `### [${t.id}] ${t.title} (${t.severity} - ${t.assigned_agent})\n${t.description}\n`)
          .join("\n");

    fs.writeFileSync(path.join(".wet", "fix_plan.md"), planContent, "utf-8");
    logger.info("Human-readable plan saved to .wet/fix_plan.md");

    return parsedBacklog;
  }

  public async run(options: OrchestratorRunOptions = {}): Promise<void> {
    const startTime = Date.now();
    await this.gitManager.checkPreflight();

    const auditBranch = await this.gitManager.initAuditBranch(options.resume);
    const tasksPath = path.join(".wet", "tasks.json");

    let backlog: Backlog | null = null;
    if (fs.existsSync(tasksPath)) {
      backlog = loadBacklog(tasksPath);
      logger.info("Loaded existing backlog from .wet/tasks.json");
    }

    if (!backlog) {
      backlog = await this.runAudit();
    }

    // When resuming, reset any tasks left 'in_progress' from a previous crash/kill back to 'pending'
    if (options.resume) {
      for (const t of backlog.tasks) {
        if (t.status === "in_progress") {
          t.status = "pending";
          logger.info({ taskId: t.id }, "Reset interrupted task from in_progress to pending");
        }
      }
      saveBacklog(tasksPath, backlog);
    }

    if (options.dryRun) {
      logger.info({ tasks: backlog.tasks.length, auditBranch }, "Dry-run mode: plan verified without executing tasks");
      return;
    }

    const workers = options.workers ?? this.config.project.max_parallel_workers;
    const scheduler = new DagScheduler({ maxParallelWorkers: workers });

    // Handle process interruption gracefully
    const handleSignal = async (sig: string) => {
      logger.warn({ signal: sig }, "Received shutdown signal. Gracefully stopping orchestrator...");
      this.stopRequested = true;
      this.stopReason = `Interrupted by ${sig}`;
      if (backlog) {
        // Leave any currently running task in pending so it can be resumed
        for (const t of backlog.tasks) {
          if (t.status === "in_progress") {
            t.status = "pending";
          }
        }
        saveBacklog(tasksPath, backlog);
        Reporter.saveReport({
          auditBranch,
          durationMs: Date.now() - startTime,
          stopReason: this.stopReason,
          backlog
        });
      }
      await this.gitManager.cleanupAll();
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    await scheduler.runScheduler(backlog.tasks, async (task: Task): Promise<TaskExecutionOutcome> => {
      if (this.stopRequested) {
        task.status = "pending";
        return "skipped";
      }

      // Check Quota Guard limits
      const quotaCheck = this.quotaGuard.shouldStop();
      if (quotaCheck.stop) {
        this.stopRequested = true;
        this.stopReason = quotaCheck.reason ?? "Quota limit reached";
        logger.warn({ reason: this.stopReason }, "QuotaGuard safety threshold reached, halting execution");
        task.status = "pending";
        return "skipped";
      }

      // Check Circuit Breaker
      if (this.circuitBreaker.isOpen()) {
        this.stopRequested = true;
        this.stopReason = `Circuit Breaker OPEN: ${this.circuitBreaker.getTripReason()}`;
        task.status = "pending";
        return "skipped";
      }

      logger.info({ taskId: task.id, agent: task.assigned_agent }, "Executing task in isolated worktree");
      const worktreePath = await this.gitManager.createWorktree(task.id);

      try {
        let taskPassed = false;
        let agentToUse = task.assigned_agent;
        let fallbackTriggered = false;

        // Execute task with primary agent
        if (agentToUse === "agy") {
          const prompt = compilePrompt("prompts/phase2-agy-digest.md", {
            TASK_ID: task.id,
            TASK_TITLE: task.title,
            TARGET_FILES: task.target_files.join(", "),
            TASK_DESCRIPTION: task.description,
            ACCEPTANCE_CRITERIA: task.acceptance_criteria.map((c) => `- ${c}`).join("\n")
          });

          const result = await this.agyAdapter.execute(prompt, { cwd: worktreePath });
          this.agyAdapter.saveAgyLog(task.id, ".wet/logs", result.output);

          if (result.status === "DONE" && result.digest) {
            task.digest = result.digest;
            taskPassed = true;
          } else if (this.config.routing.agy_fallback_to_claude) {
            logger.warn({ taskId: task.id }, "Agy failed or timed out. Triggering fallback to Claude Code");
            fallbackTriggered = true;
            agentToUse = "claude";

            // Clean worktree before fallback attempt
            await execa("git", ["reset", "--hard"], { cwd: worktreePath });
            await execa("git", ["clean", "-fd"], { cwd: worktreePath });
          } else {
            task.failure_reason = result.error ?? "Agy execution failed";
          }
        }

        if (agentToUse === "claude") {
          const prompt = compilePrompt("prompts/phase2-claude-fix.md", {
            TASK_ID: task.id,
            TASK_TITLE: task.title,
            TASK_CATEGORY: task.category,
            TASK_SEVERITY: task.severity,
            TARGET_FILES: task.target_files.join(", "),
            TASK_DESCRIPTION: task.description,
            ACCEPTANCE_CRITERIA: task.acceptance_criteria.map((c) => `- ${c}`).join("\n")
          });

          const result = await this.claudeAdapter.execute(prompt, {
            cwd: worktreePath,
            maxTurns: this.config.limits.claude_max_turns_per_task,
            maxBudgetUsd: this.config.limits.claude_max_budget_usd_per_task,
            allowedTools: "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(pnpm:*),Bash(npx:*),Bash(pytest:*),Bash(go test:*)"
          });

          if (result.status === "RATE_LIMITED") {
            this.stopRequested = true;
            this.stopReason = `Rate limit encountered: ${result.rateLimitReset ?? "wait for reset"}`;
            task.status = "pending";
            task.failure_reason = null;
            await this.gitManager.removeWorktree(task.id);
            saveBacklog(tasksPath, backlog);
            return "skipped";
          }

          if (result.status === "BLOCKED") {
            task.status = "skipped";
            task.failure_reason = result.blockedReason ?? "Marked BLOCKED by agent";
            await this.gitManager.removeWorktree(task.id);
            saveBacklog(tasksPath, backlog);
            return "skipped";
          }

          if (result.status === "DONE") {
            task.digest = result.digest;
            taskPassed = true;
          } else {
            task.failure_reason = result.error ?? "Claude execution failed";
          }
        }

        task.metrics = {
          agent_used: agentToUse,
          fallback_triggered: fallbackTriggered
        };

        if (!taskPassed) {
          this.circuitBreaker.recordFailure(task.id, task.failure_reason ?? undefined);
          await this.gitManager.removeWorktree(task.id);
          saveBacklog(tasksPath, backlog);
          return "failed";
        }

        // Run Quality Gates & Auto-Repair loop
        const gatesPassed = await this.qualityGatesRunner.runAutoRepairLoop(
          task,
          worktreePath,
          this.claudeAdapter,
          this.gitManager,
          this.config.limits.max_retries_per_task
        );

        if (!gatesPassed) {
          this.circuitBreaker.recordFailure(task.id, task.failure_reason ?? undefined);
          await this.gitManager.removeWorktree(task.id);
          saveBacklog(tasksPath, backlog);
          return "failed";
        }

        // Commit and integrate
        const sha = await this.gitManager.commitTaskInWorktree(task.id, task, worktreePath);
        task.commit_sha = sha;

        const integrated = await this.gitManager.integrateTask(task.id, sha, worktreePath, async () => {
          const res = await this.qualityGatesRunner.runAllGates(worktreePath);
          return res.passed;
        });

        if (integrated) {
          this.circuitBreaker.recordSuccess();
          const anomaly = await this.burnProfiler.profileTask(task, backlog.tasks);
          if (anomaly.hasAnomaly) {
            logger.warn({ taskId: task.id, anomaly }, "Burn profiler detected anomaly");
          }
        } else {
          task.failure_reason = "Failed integration merge/cherry-pick onto audit branch";
          this.circuitBreaker.recordFailure(task.id, task.failure_reason);
        }

        await this.gitManager.removeWorktree(task.id);
        saveBacklog(tasksPath, backlog);
        return integrated ? "completed" : "failed";
      } catch (err: any) {
        logger.error({ taskId: task.id, err }, "Unexpected error in task execution");
        task.failure_reason = err?.message || String(err);
        this.circuitBreaker.recordFailure(task.id, task.failure_reason ?? undefined);
        await this.gitManager.removeWorktree(task.id);
        saveBacklog(tasksPath, backlog);
        return "failed";
      }
    });

    const reportPath = Reporter.saveReport({
      auditBranch,
      durationMs: Date.now() - startTime,
      stopReason: this.stopReason,
      backlog
    });
    logger.info({ reportPath }, "Audit session completed. Full report generated.");
  }
}
