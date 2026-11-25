import { execa } from "execa";
import {
  type AgentAdapter,
  type AgentExecutionOptions,
  type ExecutionResult,
  type UsageSnapshot,
  parseExitSignal,
  parseDigest,
  parseUsageText
} from "./agent-adapter.js";
import type { CustomProviderConfig, WetGlobalConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export class CustomAdapter implements AgentAdapter {
  public readonly provider = "custom" as const;
  private readonly config: CustomProviderConfig;

  constructor(config?: CustomProviderConfig) {
    this.config = config ?? {
      binary: "custom-ai",
      audit_args: ["-p", "{{PROMPT}}"],
      exec_args: ["-p", "{{PROMPT}}"],
      use_pty: false
    };
  }

  public async checkInstalled(): Promise<{ available: boolean; version?: string; binaryPath?: string }> {
    try {
      const { stdout } = await execa(this.config.binary, ["--version"]);
      return { available: true, version: stdout.trim(), binaryPath: this.config.binary };
    } catch {
      return { available: false };
    }
  }

  public getTopModelProfile(config: WetGlobalConfig): { model: string; effort?: string; extraFlags: string[] } {
    return {
      model: config.model_override && config.model_override !== "auto" ? config.model_override : "custom-top",
      effort: config.reasoning_effort,
      extraFlags: []
    };
  }

  public async probeUsage(): Promise<UsageSnapshot> {
    const startTime = Date.now();
    let snippet = "";
    if (this.config.usage_cmd) {
      try {
        const parts = this.config.usage_cmd.split(" ");
        const cmd = parts[0]!;
        const args = parts.slice(1);
        const { stdout } = await execa(cmd, args, { timeout: 8000 });
        snippet = stdout;
      } catch {
        // Fallback
      }
    }
    const parsed = parseUsageText(snippet);
    return {
      provider: "custom",
      probedAt: new Date(startTime),
      source: parsed.weeklyUsedPct !== null ? "cli_probe" : "fallback_manual",
      buckets: parsed.buckets,
      weeklyUsedPct: parsed.weeklyUsedPct,
      weeklyResetAt: parsed.weeklyResetAt,
      window5hUsedPct: parsed.window5hUsedPct,
      window5hResetAt: parsed.window5hResetAt,
      rawSnippet: snippet.slice(0, 300)
    };
  }

  private replacePrompt(args: string[] | undefined, prompt: string): string[] {
    if (!args || !Array.isArray(args)) {
      return ["-p", prompt];
    }
    return args.map((arg) => (arg.includes("{{PROMPT}}") ? arg.replace("{{PROMPT}}", prompt) : arg));
  }

  public async runAudit(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const args = this.replacePrompt(this.config.audit_args, prompt);
    return this.executeArgs(args, { ...options, cwd: workdir, phase: "audit" });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const args = this.replacePrompt(this.config.exec_args, prompt);
    return this.executeArgs(args, { ...options, cwd: workdir, phase: "execute" });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const args = this.replacePrompt(this.config.exec_args, prompt);
    return this.executeArgs(args, { ...options, cwd: workdir, phase: "repair" });
  }

  private async executeArgs(args: string[], options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    let fullOutput = "";
    let fullStderr = "";

    const taskTimeoutMs = (options.timeoutSec ?? 300) * 1000;
    let effectiveTimeoutMs = taskTimeoutMs;
    if (options.deadlineAt) {
      const remainingUntilDeadline = options.deadlineAt.getTime() - Date.now();
      if (remainingUntilDeadline <= 0) {
        return {
          exitCode: 124,
          status: "FAILED",
          digest: null,
          output: "",
          error: "Process not started: hard deadline already expired",
          metrics: { durationMs: 0 }
        };
      }
      effectiveTimeoutMs = Math.min(taskTimeoutMs, remainingUntilDeadline);
    }

    try {
      const subprocess = execa(this.config.binary, args, {
        cwd: options.cwd,
        timeout: effectiveTimeoutMs,
        cleanup: true,
        env: {
          ...(process.env as Record<string, string>)
        }
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        fullOutput += text;
        options.onChunk?.(text);
      });

      subprocess.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        fullStderr += text;
        options.onChunk?.(text);
      });

      const { exitCode } = await subprocess;
      const durationMs = Date.now() - startTime;
      const combined = (fullOutput + "\n" + fullStderr).trim();

      const isRateLimit =
        combined.includes("429") ||
        combined.includes("rate limit") ||
        combined.includes("quota exceeded");

      if (isRateLimit) {
        const parsed = parseUsageText(combined);
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          rateLimitType: combined.toLowerCase().includes("weekly") ? "weekly" : "5h",
          rateLimitReset: parsed.window5hResetAt?.toISOString() ?? parsed.weeklyResetAt?.toISOString(),
          digest: null,
          output: combined,
          error: "Rate limit reached in custom provider",
          metrics: { durationMs }
        };
      }

      const signal = parseExitSignal(combined);
      const digest = parseDigest(combined);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: combined,
          blockedReason: signal.reason,
          metrics: { durationMs }
        };
      }

      if (exitCode === 0 && signal.status === "DONE") {
        const phase = options.phase ?? "execute";
        if (phase === "audit" || phase === "repair" || digest !== null) {
          return {
            exitCode: 0,
            status: "DONE",
            digest,
            output: combined,
            metrics: { durationMs }
          };
        }

        logger.warn({ taskId: options.taskId }, "Custom provider finished with status=DONE but missing <WET_DIGEST>. Generating synthetic fallback digest.");
        return {
          exitCode: 0,
          status: "DONE",
          digest: {
            files_changed: [],
            summary: "Completed without structured digest",
            tests_added: 0,
            risks: []
          },
          output: combined,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: exitCode ?? 1,
        status: "FAILED",
        digest,
        output: combined,
        error: `Custom provider exited with code ${exitCode}`,
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const combined = (fullOutput + "\n" + fullStderr + "\n" + (err?.message || "")).trim();
      return {
        exitCode: 1,
        status: "FAILED",
        digest: null,
        output: combined,
        error: err?.message || String(err),
        metrics: { durationMs }
      };
    }
  }
}
