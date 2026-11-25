import { execa } from "execa";
import type { QualityGateCommand, Task } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import { compilePrompt } from "../config/loader.js";
import type { AgentAdapter } from "../adapters/agent-adapter.js";
import type { GitManager } from "../git/git-manager.js";

export interface QualityGateRunResult {
  passed: boolean;
  failedGate?: QualityGateCommand;
  errorOutput?: string;
  durationMs: number;
}

export class QualityGatesRunner {
  private readonly commands: QualityGateCommand[];
  private readonly timeoutSec: number;

  constructor(commands: QualityGateCommand[], timeoutSec = 120) {
    this.commands = commands;
    this.timeoutSec = timeoutSec;
  }

  public async runAllGates(worktreePath: string): Promise<QualityGateRunResult> {
    const startTime = Date.now();

    for (const gate of this.commands) {
      logger.info({ gate: gate.name, cmd: gate.cmd }, "Running quality gate");
      try {
        const [cmd, ...args] = gate.cmd.split(" ");
        if (!cmd) continue;

        await execa(cmd, args, {
          cwd: worktreePath,
          timeout: this.timeoutSec * 1000,
          shell: true
        });
      } catch (err: any) {
        const rawOutput = (err?.stdout || "") + "\n" + (err?.stderr || "") + "\n" + (err?.message || "");
        const lines = rawOutput.split("\n");
        const truncatedOutput = lines.slice(-120).join("\n");

        logger.warn({ gate: gate.name, lines: lines.length }, "Quality gate failed");
        return {
          passed: false,
          failedGate: gate,
          errorOutput: truncatedOutput,
          durationMs: Date.now() - startTime
        };
      }
    }

    return {
      passed: true,
      durationMs: Date.now() - startTime
    };
  }

  public async runAutoRepairLoop(
    task: Task,
    worktreePath: string,
    adapter: AgentAdapter,
    gitManager: GitManager,
    maxRetries = 3,
    promptTemplatePath = "prompts/phase3-repair.md",
    deadlineAt?: Date,
    model?: string,
    extraFlags?: string[]
  ): Promise<boolean> {
    let gateResult = await this.runAllGates(worktreePath);
    if (gateResult.passed) {
      return true;
    }

    let attempt = 0;
    while (!gateResult.passed && attempt < maxRetries) {
      attempt++;
      task.retries = attempt;
      logger.info(
        { taskId: task.id, attempt, maxRetries, failedGate: gateResult.failedGate?.name, provider: adapter.provider },
        "Initiating auto-repair session with provider"
      );

      const gitDiff = await gitManager.getDiff(worktreePath);
      const repairPrompt = compilePrompt(promptTemplatePath, {
        TASK_ID: task.id,
        TASK_TITLE: task.title,
        GATE_NAME: gateResult.failedGate?.name ?? "unknown",
        GATE_CMD: gateResult.failedGate?.cmd ?? "unknown",
        ERROR_OUTPUT: gateResult.errorOutput ?? "Unknown error",
        GIT_DIFF: gitDiff || "(no unstaged diff)"
      });

      const repairResult = await adapter.runRepair(repairPrompt, worktreePath, {
        allowedTools: "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(pnpm:*),Bash(npx:*),Bash(pytest:*),Bash(go test:*)",
        deadlineAt,
        model,
        extraFlags,
        phase: "repair",
        taskId: task.id
      });

      if (repairResult.status === "BLOCKED") {
        logger.warn({ taskId: task.id, reason: repairResult.blockedReason }, "Repair session reported BLOCKED");
        task.failure_reason = `Blocked during repair: ${repairResult.blockedReason}`;
        return false;
      }

      // Re-run gates after repair attempt
      gateResult = await this.runAllGates(worktreePath);
      if (gateResult.passed) {
        logger.info({ taskId: task.id, attempt }, "Quality gates passed after repair!");
        return true;
      }
    }

    task.failure_reason = `Quality gate '${gateResult.failedGate?.name}' failed after ${maxRetries} repair attempts`;
    return false;
  }
}
