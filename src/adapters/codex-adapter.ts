import { execa } from "execa";
import pty from "node-pty";
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

export interface CodexAdapterConfig {
  binary?: string;
  defaultModel?: string;
}

export function extractTextFromCodexStream(rawOutput: string): string {
  const lines = rawOutput.split(/\r?\n/);
  const textChunks: string[] = [];
  let parsedAnyJson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      parsedAnyJson = true;

      if (typeof parsed === "object" && parsed !== null) {
        if (typeof parsed.content === "string") {
          textChunks.push(parsed.content);
        } else if (Array.isArray(parsed.content)) {
          for (const item of parsed.content) {
            if (typeof item === "string") textChunks.push(item);
            else if (item && typeof item.text === "string") textChunks.push(item.text);
            else if (item && typeof item.content === "string") textChunks.push(item.content);
          }
        }

        if (typeof parsed.text === "string") {
          textChunks.push(parsed.text);
        }

        if (parsed.item && typeof parsed.item === "object") {
          if (typeof parsed.item.content === "string") {
            textChunks.push(parsed.item.content);
          } else if (Array.isArray(parsed.item.content)) {
            for (const item of parsed.item.content) {
              if (typeof item === "string") textChunks.push(item);
              else if (item && typeof item.text === "string") textChunks.push(item.text);
            }
          } else if (typeof parsed.item.text === "string") {
            textChunks.push(parsed.item.text);
          }
        }

        if (parsed.delta && typeof parsed.delta === "object") {
          if (typeof parsed.delta.text === "string") textChunks.push(parsed.delta.text);
          else if (typeof parsed.delta.content === "string") textChunks.push(parsed.delta.content);
        }

        if (parsed.message && typeof parsed.message === "object") {
          if (typeof parsed.message.content === "string") textChunks.push(parsed.message.content);
        }
      }
    } catch {
      // Line is not valid JSON
    }
  }

  if (parsedAnyJson && textChunks.length > 0) {
    return textChunks.join("\n");
  }

  return rawOutput;
}

export class CodexAdapter implements AgentAdapter {
  public readonly provider = "codex" as const;
  private readonly binary: string;
  private readonly defaultModel: string;

  constructor(config: CodexAdapterConfig = {}) {
    this.binary = config.binary ?? "codex";
    this.defaultModel = config.defaultModel ?? "o3-mini";
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
    const extraFlags = ["-c", `model_reasoning_effort="${effort === "max" ? "high" : effort}"`];
    return { model, effort, extraFlags };
  }

  public async probeUsage(): Promise<UsageSnapshot> {
    const startTime = Date.now();
    let ptyOutput = "";

    try {
      ptyOutput = await new Promise<string>((resolve) => {
        let full = "";
        let proc: pty.IPty | null = null;
        const timer = setTimeout(() => {
          try {
            proc?.kill("SIGKILL");
          } catch {
            // Ignore
          }
          resolve(full);
        }, 10000);

        try {
          proc = pty.spawn(this.binary, ["status"], {
            name: "xterm-color",
            cols: 120,
            rows: 40,
            env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" }
          });

          proc.onData((data: string) => {
            full += data;
          });

          proc.onExit(() => {
            clearTimeout(timer);
            resolve(full);
          });
        } catch {
          clearTimeout(timer);
          resolve(full);
        }
      });
    } catch (err) {
      logger.debug({ err }, "Codex usage probe error");
    }

    const parsed = parseUsageText(ptyOutput);
    return {
      provider: "codex",
      probedAt: new Date(startTime),
      source: parsed.weeklyUsedPct !== null ? "cli_probe" : "fallback_manual",
      buckets: parsed.buckets,
      weeklyUsedPct: parsed.weeklyUsedPct,
      weeklyResetAt: parsed.weeklyResetAt,
      window5hUsedPct: parsed.window5hUsedPct,
      window5hResetAt: parsed.window5hResetAt,
      rawSnippet: ptyOutput.slice(0, 300)
    };
  }

  public async runAudit(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      allowedTools: "read-only",
      phase: "audit"
    });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      allowedTools: "workspace-write",
      phase: "execute"
    });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      allowedTools: "workspace-write",
      phase: "repair"
    });
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const isReadOnly = options.allowedTools === "read-only";
    const phase = options.phase ?? (isReadOnly ? "audit" : "execute");

    const args = ["exec"];
    if (isReadOnly) {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write", "--full-auto");
    }
    args.push("--json");

    if (options.model) {
      args.push("-m", options.model);
    }

    if (options.extraFlags && options.extraFlags.length > 0) {
      args.push(...options.extraFlags);
    }

    let input: string | undefined = undefined;
    if (prompt.length > 32 * 1024) {
      args.push("-");
      input = prompt;
    } else {
      args.push(prompt);
    }

    let fullOutput = "";
    let fullStderr = "";
    let rateLimited = false;
    let rateLimitReset: string | undefined;
    let rateLimitType: "5h" | "weekly" | undefined;

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
        input,
        env: {
          ...process.env,
          CI: "1"
        }
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        fullOutput += str;
        options.onChunk?.(str);
        if (/rate[_\s]limit|429|quota|usage limit|too many requests/i.test(str)) {
          rateLimited = true;
          if (/weekly/i.test(str)) rateLimitType = "weekly";
          else rateLimitType = "5h";
          const match = str.match(/resets?\s+(?:at\s+|in\s+)?([^\n,.]+)/i);
          if (match?.[1]) rateLimitReset = match[1].trim();
        }
      });

      subprocess.stderr?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        fullStderr += str;
        if (/rate[_\s]limit|429|quota|usage limit|too many requests/i.test(str)) {
          rateLimited = true;
          if (/weekly/i.test(str)) rateLimitType = "weekly";
          else rateLimitType = "5h";
          const match = str.match(/resets?\s+(?:at\s+|in\s+)?([^\n,.]+)/i);
          if (match?.[1]) rateLimitReset = match[1].trim();
        }
      });

      const result = await subprocess;
      const durationMs = Date.now() - startTime;

      const extractedText = extractTextFromCodexStream(fullOutput);

      if (rateLimited) {
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: extractedText,
          error: fullStderr,
          rateLimitReset,
          rateLimitType,
          metrics: { durationMs }
        };
      }

      const signal = parseExitSignal(extractedText);
      const digest = parseDigest(extractedText);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: extractedText,
          blockedReason: signal.reason,
          metrics: { durationMs }
        };
      }

      if (result.exitCode === 0 && signal.status === "DONE") {
        if (phase === "audit" || phase === "repair" || digest !== null) {
          return {
            exitCode: 0,
            status: "DONE",
            digest,
            output: extractedText,
            metrics: { durationMs }
          };
        }

        // Phase === "execute" with missing digest: provide synthetic fallback
        logger.warn({ taskId: options.taskId }, "Codex finished with status=DONE but missing <WET_DIGEST>. Generating synthetic fallback digest.");
        return {
          exitCode: 0,
          status: "DONE",
          digest: {
            files_changed: [],
            summary: "Completed without structured digest",
            tests_added: 0,
            risks: []
          },
          output: extractedText,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: result.exitCode ?? 1,
        status: "FAILED",
        digest,
        output: extractedText,
        error: signal.status === null ? "Missing <WET_EXIT_SIGNAL status=\"DONE\"/> marker" : fullStderr,
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const extractedOutput = extractTextFromCodexStream(fullOutput);
      const errCombined = `${extractedOutput}\n${fullStderr}\n${err?.stdout ?? ""}\n${err?.stderr ?? ""}\n${err?.message ?? ""}`;
      const isRateLimit =
        /rate[_\s]limit|429|quota|usage limit|too many requests/i.test(errCombined) ||
        err?.exitCode === 429;

      if (isRateLimit) {
        const parsed = parseUsageText(errCombined);
        const isWeekly = errCombined.toLowerCase().includes("weekly");
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: extractedOutput || errCombined,
          error: err?.message || "Rate limit reached in codex",
          rateLimitReset: parsed.window5hResetAt?.toISOString() ?? parsed.weeklyResetAt?.toISOString(),
          rateLimitType: isWeekly ? "weekly" : "5h",
          metrics: { durationMs }
        };
      }

      return {
        exitCode: err?.exitCode ?? 1,
        status: "FAILED",
        digest: parseDigest(extractedOutput),
        output: extractedOutput,
        error: err?.message || String(err),
        metrics: { durationMs }
      };
    }
  }
}
