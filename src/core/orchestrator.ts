import fs from "node:fs";
import path from "node:path";
import { type WetConfig, type Backlog, type Task, type WetGlobalConfig } from "../config/schema.js";
import { GitManager } from "../git/git-manager.js";
import { DagScheduler, type TaskExecutionOutcome } from "./dag-scheduler.js";
import { type AgentAdapter } from "../adapters/agent-adapter.js";
import { ClaudeAdapter } from "../adapters/claude-adapter.js";
import { QualityGatesRunner } from "./quality-gates.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { CycleGuard } from "../scheduler/cycle-guard.js";
import { QuotaGuard } from "../telemetry/quota-guard.js";
import { BurnProfiler } from "../telemetry/burn-profiler.js";
import { Reporter } from "../telemetry/reporter.js";
import { compilePrompt, loadBacklog, saveBacklog, getWetDir, autoDetectQualityGates } from "../config/loader.js";
import { parseBacklogJson, parseFixPlanMd, type ExecutionResult } from "../adapters/agent-adapter.js";
import { logger } from "../utils/logger.js";
import { loadGlobalConfig } from "../config/global-store.js";

export interface OrchestratorRunOptions {
  dryRun?: boolean;
  workers?: number;
  maxBudget?: number;
  resume?: boolean;
  hardStopAt?: Date;
  selectedModel?: string | null;
  onBeforeTaskCheck?: () => Promise<{ allowed: boolean; reason?: string }>;
}

export interface WaveRunResult {
  outcome:
    | "COMPLETED"
    | "RATE_LIMITED_5H"
    | "RATE_LIMITED_WEEKLY"
    | "HARD_STOP_REACHED"
    | "CIRCUIT_BREAKER"
    | "STOPPED"
    | "EARLY_RESET_DETECTED"
    | "YIELDED_TO_USER";
  stopReason: string;
  tasksCompleted: number;
  tasksFailed: number;
  reportPath?: string;
}

export class Orchestrator {
  private readonly config: WetConfig;
  private readonly globalConfig: WetGlobalConfig;
  private readonly gitManager: GitManager;
  private readonly adapter: AgentAdapter;
  private readonly qualityGatesRunner: QualityGatesRunner;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly quotaGuard: QuotaGuard;
  private readonly burnProfiler: BurnProfiler;
  private stopRequested = false;
  private stopReason = "Backlog completed";
  private rateLimitType?: "5h" | "weekly";

  constructor(config: WetConfig, adapter?: AgentAdapter, globalConfig?: WetGlobalConfig) {
    this.config = config;
    this.globalConfig = globalConfig ?? loadGlobalConfig();
    const wetDir = getWetDir(config.project.root);

    if (config.quality_gates.auto_detect) {
      config.quality_gates.commands = autoDetectQualityGates(config.project.root);
    }

    this.gitManager = new GitManager({
      repoRoot: config.project.root,
      baseBranch: config.project.base_branch,
      auditBranchPrefix: config.project.audit_branch_prefix,
      worktreeDir: config.project.worktree_dir
    });

    this.adapter =
      adapter ??
      new ClaudeAdapter({
        binary: config.claude?.binary,
        defaultModel: config.claude?.model
      });

    this.qualityGatesRunner = new QualityGatesRunner(
      config.quality_gates.commands,
      config.quality_gates.gate_timeout_sec
    );

    this.circuitBreaker = new CircuitBreaker({
      maxConsecutiveFailures: config.limits.max_consecutive_failures
    });

    this.quotaGuard = new QuotaGuard(
      {
        claudeMaxSessionBudgetUsd: config.limits.claude_max_session_budget_usd,
        stopAtFiveHourQuotaPct: config.limits.stop_at_five_hour_quota_pct,
        stopAtWeeklyQuotaPct: config.limits.stop_at_weekly_quota_pct
      },
      path.join(wetDir, "quota-state.json")
    );

    this.burnProfiler = new BurnProfiler();
  }

  public async runAudit(maxTasks?: number): Promise<Backlog> {
    const max = maxTasks ?? this.config.limits.max_total_tasks;
    logger.info({ maxTasks: max, provider: this.adapter.provider }, "Starting Phase 1 Read-Only Codebase Audit");

    const wetDir = getWetDir(this.config.project.root);
    fs.mkdirSync(wetDir, { recursive: true });

    const auditWorktreePath = await this.gitManager.createAuditWorktree();
    let result: ExecutionResult;

    try {
      const auditPrompt = compilePrompt("prompts/phase1-audit.md", {
        REPO_PATH: path.resolve(auditWorktreePath),
        MAX_TASKS: String(max)
      });

      const modelProfile = this.adapter.getTopModelProfile(this.globalConfig);
      result = await this.adapter.runAudit(auditPrompt, auditWorktreePath, {
        model: modelProfile.model,
        extraFlags: modelProfile.extraFlags,
        allowedTools: "Read,Glob,Grep",
        phase: "audit"
      });
    } finally {
      await this.gitManager.removeAuditWorktree();
    }

    if (result.status === "RATE_LIMITED") {
      throw new Error(`${this.adapter.provider} is rate limited: ${result.rateLimitReset ?? "try again later"}`);
    }

    const parsedBacklog = parseBacklogJson(result.output);
    if (!parsedBacklog) {
      throw new Error("Phase 1 Audit did not return valid JSON in <WET_BACKLOG_JSON> tags");
    }

    // Save tasks.json
    const tasksPath = path.join(wetDir, "tasks.json");
    saveBacklog(tasksPath, parsedBacklog);
    logger.info({ taskCount: parsedBacklog.tasks.length }, "Audit backlog saved to tasks.json");

    // Save fix_plan.md
    const fixPlanMd = parseFixPlanMd(result.output);
    const planContent =
      fixPlanMd ??
      `# WorthEveryToken Fix Plan\n\nGenerated: ${parsedBacklog.generated_at}\n\n` +
        parsedBacklog.tasks
          .map((t) => `### [${t.id}] ${t.title} (${t.severity} - ${t.assigned_agent ?? this.adapter.provider})\n${t.description}\n`)
          .join("\n");

    fs.writeFileSync(path.join(wetDir, "fix_plan.md"), planContent, "utf-8");
    logger.info("Human-readable plan saved to fix_plan.md");

    return parsedBacklog;
  }

  public async runWave(options: OrchestratorRunOptions = {}): Promise<WaveRunResult> {
    const startTime = Date.now();
    await this.gitManager.checkPreflight();

    const auditBranch = await this.gitManager.initAuditBranch(options.resume);
    const wetDir = getWetDir(this.config.project.root);
    const tasksPath = path.join(wetDir, "tasks.json");

    let backlog: Backlog | null = null;
    if (fs.existsSync(tasksPath)) {
      backlog = loadBacklog(tasksPath);
      logger.info("Loaded existing backlog from tasks.json");
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
      return {
        outcome: "COMPLETED",
        stopReason: "Dry-run verified",
        tasksCompleted: 0,
        tasksFailed: 0
      };
    }

    const workers = options.workers ?? this.config.project.max_parallel_workers;
    const scheduler = new DagScheduler({ maxParallelWorkers: workers });

    // Handle process interruption gracefully
    const handleSignal = async (sig: string) => {
      logger.warn({ signal: sig }, "Received shutdown signal. Gracefully stopping orchestrator...");
      this.stopRequested = true;
      this.stopReason = `Interrupted by ${sig}`;
      if (backlog) {
        for (const t of backlog.tasks) {
          if (t.status === "in_progress") {
            t.status = "pending";
          }
        }
        saveBacklog(tasksPath, backlog);
        Reporter.saveReport(
          {
            auditBranch,
            durationMs: Date.now() - startTime,
            stopReason: this.stopReason,
            backlog
          },
          wetDir
        );
      }
      await this.gitManager.cleanupAll();
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    await scheduler.runScheduler(backlog.tasks, async (task: Task): Promise<TaskExecutionOutcome> => {
      if (this.stopRequested) {
        task.status = "pending";
        return "aborted";
      }

      // Check external safety callback (CycleGuard Level 1 & 3, UserActivityGuard)
      if (options.onBeforeTaskCheck) {
        const check = await options.onBeforeTaskCheck();
        if (!check.allowed) {
          this.stopRequested = true;
          this.stopReason = check.reason ?? "Safety check halted execution";
          logger.warn({ reason: this.stopReason }, "Halting wave before task start");
          task.status = "pending";
          return "aborted";
        }
      }

      // Check hardStopAt and CycleGuard fit check before starting a new task
      if (options.hardStopAt) {
        const fitCheck = CycleGuard.canStartNextTask({
          now: new Date(),
          hardStopAt: options.hardStopAt,
          minTaskReserveMinutes: 6
        });
        if (!fitCheck.allowed) {
          this.stopRequested = true;
          this.stopReason = fitCheck.reason ?? "HARD_STOP_PRE_RESET";
          logger.warn({ reason: this.stopReason }, "Halting wave before task start");
          task.status = "pending";
          return "aborted";
        }
      }

      // Check Quota Guard limits (ONLY for Claude provider)
      if (this.adapter.provider === "claude") {
        const quotaCheck = this.quotaGuard.shouldStop();
        if (quotaCheck.stop) {
          this.stopRequested = true;
          this.stopReason = quotaCheck.reason ?? "Quota limit reached";
          logger.warn({ reason: this.stopReason }, "QuotaGuard safety threshold reached, halting execution");
          task.status = "pending";
          return "aborted";
        }
      }

      // Check Circuit Breaker
      if (this.circuitBreaker.isOpen()) {
        this.stopRequested = true;
        this.stopReason = `Circuit Breaker OPEN: ${this.circuitBreaker.getTripReason()}`;
        task.status = "pending";
        return "aborted";
      }

      const modelProfile = this.adapter.getTopModelProfile(this.globalConfig);
      const effectiveModel = options.selectedModel ?? modelProfile.model;

      logger.info({ taskId: task.id, provider: this.adapter.provider, model: effectiveModel }, "Executing task in isolated worktree");
      const worktreePath = await this.gitManager.createWorktree(task.id);

      try {
        let taskPassed = false;

        const promptPath = fs.existsSync("prompts/phase2-execute.md")
          ? "prompts/phase2-execute.md"
          : "prompts/phase2-claude-fix.md";

        const prompt = compilePrompt(promptPath, {
          TASK_ID: task.id,
          TASK_TITLE: task.title,
          TASK_CATEGORY: task.category,
          TASK_SEVERITY: task.severity,
          TARGET_FILES: task.target_files.join(", "),
          TASK_DESCRIPTION: task.description,
          ACCEPTANCE_CRITERIA: task.acceptance_criteria.map((c) => `- ${c}`).join("\n")
        });

        const result = await this.adapter.runTask(prompt, worktreePath, {
          maxTurns: this.config.limits.claude_max_turns_per_task,
          maxBudgetUsd: this.config.limits.claude_max_budget_usd_per_task,
          deadlineAt: options.hardStopAt,
          model: effectiveModel,
          extraFlags: modelProfile.extraFlags,
          taskId: task.id,
          phase: "execute"
        });

        if (result.status === "RATE_LIMITED") {
          this.stopRequested = true;
          this.rateLimitType = result.rateLimitType ?? "5h";
          this.stopReason = `Rate limit encountered (${this.rateLimitType}): ${result.rateLimitReset ?? "wait for reset"}`;
          task.status = "pending";
          task.failure_reason = null;
          await this.gitManager.removeWorktree(task.id);
          saveBacklog(tasksPath, backlog);
          return "aborted";
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
          task.failure_reason = result.error ?? "Execution failed";
        }

        task.metrics = {
          provider: this.adapter.provider,
          agent_used: this.adapter.provider,
          fallback_triggered: false
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
          this.adapter,
          this.gitManager,
          this.config.limits.max_retries_per_task,
          "prompts/phase3-repair.md",
          options.hardStopAt,
          effectiveModel,
          modelProfile.extraFlags
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

    const reportPath = Reporter.saveReport(
      {
        auditBranch,
        durationMs: Date.now() - startTime,
        stopReason: this.stopReason,
        backlog
      },
      wetDir
    );
    logger.info({ reportPath }, "Session completed. Full report generated.");

    const completedCount = backlog.tasks.filter((t) => t.status === "completed").length;
    const failedCount = backlog.tasks.filter((t) => t.status === "failed").length;

    let outcome: WaveRunResult["outcome"] = "COMPLETED";
    if (this.stopReason.includes("YIELDED_TO_USER")) {
      outcome = "YIELDED_TO_USER";
    } else if (this.stopReason.includes("EARLY_RESET_DETECTED")) {
      outcome = "EARLY_RESET_DETECTED";
    } else if (this.rateLimitType === "5h" || this.stopReason.includes("5h")) {
      outcome = "RATE_LIMITED_5H";
    } else if (this.rateLimitType === "weekly" || this.stopReason.includes("weekly")) {
      outcome = "RATE_LIMITED_WEEKLY";
    } else if (this.stopReason.includes("HARD_STOP")) {
      outcome = "HARD_STOP_REACHED";
    } else if (this.circuitBreaker.isOpen()) {
      outcome = "CIRCUIT_BREAKER";
    } else if (this.stopRequested) {
      outcome = "STOPPED";
    }

    return {
      outcome,
      stopReason: this.stopReason,
      tasksCompleted: completedCount,
      tasksFailed: failedCount,
      reportPath
    };
  }

  public async run(options: OrchestratorRunOptions = {}): Promise<void> {
    await this.runWave(options);
  }
}
