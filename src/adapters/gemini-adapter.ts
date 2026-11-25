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
import type { WetGlobalConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface GeminiAdapterConfig {
  binary?: string;
  defaultModel?: string;
}

export class GeminiAdapter implements AgentAdapter {
  public readonly provider = "gemini" as const;
  private readonly binary: string;
  private readonly defaultModel: string;

  constructor(config: GeminiAdapterConfig = {}) {
    this.binary = config.binary ?? "gemini";
    this.defaultModel = config.defaultModel ?? "gemini-2.5-pro";
  }

  public async checkInstalled(): Promise<{ available: boolean; version?: string; binaryPath?: string }> {
    try {
      const { stdout } = await execa(this.binary, ["--version"]);
      return { available: true, version: stdout.trim(), binaryPath: this.binary };
    } catch {
      return { available: false };
    }
  }

  public getTopModelProfile(config: WetGlobalConfig): { model: string; effort?: string; extraFlags: string[] } {
    const model = config.model_override && config.model_override !== "auto" ? config.model_override : this.defaultModel;
    const effort = config.reasoning_effort ?? "max";
    const extraFlags = ["--output-format", "json"];
    return { model, effort, extraFlags };
  }

  public async probeUsage(): Promise<UsageSnapshot> {
    const startTime = Date.now();
    let snippet = "";
    try {
      const { stdout } = await execa(this.binary, ["status"], { timeout: 8000 });
      snippet = stdout;
    } catch {
      // Fallback
    }
    const parsed = parseUsageText(snippet);
    return {
      provider: "gemini",
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

  public async runAudit(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      phase: "audit"
    });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      phase: "execute"
    });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      phase: "repair"
    });
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args: string[] = ["-p", prompt, "--output-format", "json", ...(options.extraFlags ?? [])];
    if (options.model) {
      args.push("-m", options.model);
    }

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
      const subprocess = execa(this.binary, args, {
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
        combined.includes("RESOURCE_EXHAUSTED") ||
        combined.includes("quota exceeded") ||
        combined.includes("rate limit");

      if (isRateLimit) {
        const parsed = parseUsageText(combined);
        const isWeekly = combined.toLowerCase().includes("weekly");
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          rateLimitType: isWeekly ? "weekly" : "5h",
          rateLimitReset: parsed.window5hResetAt?.toISOString() ?? parsed.weeklyResetAt?.toISOString(),
          digest: null,
          output: combined,
          error: "Rate limit / quota exceeded in Gemini CLI",
          metrics: { durationMs }
        };
      }

      // Try unwrap JSON if Gemini wrapped output
      let textToParse = combined;
      try {
        const parsedJson = JSON.parse(fullOutput.trim());
        if (parsedJson && typeof parsedJson === "object") {
          textToParse =
            parsedJson.response ??
            parsedJson.result ??
            parsedJson.content ??
            parsedJson.text ??
            combined;
        }
      } catch {
        // Not JSON
      }

      const signal = parseExitSignal(textToParse);
      const digest = parseDigest(textToParse);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: textToParse,
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
            output: textToParse,
            metrics: { durationMs }
          };
        }

        logger.warn({ taskId: options.taskId }, "Gemini finished with status=DONE but missing <WET_DIGEST>. Generating synthetic fallback digest.");
        return {
          exitCode: 0,
          status: "DONE",
          digest: {
            files_changed: [],
            summary: "Completed without structured digest",
            tests_added: 0,
            risks: []
          },
          output: textToParse,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: exitCode ?? 1,
        status: "FAILED",
        digest,
        output: textToParse,
        error: `Gemini CLI exited with code ${exitCode} without valid completion protocol`,
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const combined = (fullOutput + "\n" + fullStderr + "\n" + (err?.message || "")).trim();

      const isRateLimit =
        combined.includes("429") ||
        combined.includes("RESOURCE_EXHAUSTED") ||
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
          error: "Rate limit / quota exceeded in Gemini CLI",
          metrics: { durationMs }
        };
      }

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
