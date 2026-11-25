import { execa } from "execa";
import pty from "node-pty";
import {
  type AgentAdapter,
  type AgentExecutionOptions,
  type ExecutionResult,
  type UsageSnapshot,
  parseExitSignal,
  parseDigest,
  extractTextFromClaudeStream,
  parseUsageText
} from "./agent-adapter.js";
import type { WetGlobalConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";
import { QuotaGuard } from "../telemetry/quota-guard.js";

export interface ClaudeAdapterConfig {
  binary?: string;
  defaultModel?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  public readonly provider = "claude" as const;
  private readonly binary: string;
  private readonly defaultModel: string;

  constructor(config: ClaudeAdapterConfig = {}) {
    this.binary = config.binary ?? "claude";
    this.defaultModel = config.defaultModel ?? "sonnet";
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
    if (config.model_override && config.model_override !== "auto") {
      return { model: config.model_override, extraFlags: [] };
    }
    return { model: "opus", extraFlags: [] };
  }

  public async probeUsage(): Promise<UsageSnapshot> {
    const startTime = Date.now();
    let ptyOutput = "";

    try {
      // 1. Live PTY probe via /usage
      ptyOutput = await new Promise<string>((resolve) => {
        let full = "";
        let proc: pty.IPty | null = null;
        let settleTimer: NodeJS.Timeout | null = null;

        const cleanupAndResolve = () => {
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          clearTimeout(globalTimer);
          try {
            proc?.write("/exit\r");
            setTimeout(() => {
              try {
                proc?.kill("SIGKILL");
              } catch {
                // Ignore
              }
            }, 300);
          } catch {
            // Ignore
          }
          resolve(full);
        };

        const globalTimer = setTimeout(() => {
          try {
            proc?.kill("SIGKILL");
          } catch {
            // Ignore
          }
          resolve(full);
        }, 15000);

        try {
          proc = pty.spawn(this.binary, [], {
            name: "xterm-color",
            cols: 120,
            rows: 40,
            env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" }
          });

          proc.onData((data: string) => {
            full += data;
            // Settle debounce: when relevant usage box output appears, wait 1200ms after last chunk
            if (
              full.includes("5-hour") ||
              full.includes("Weekly") ||
              full.includes("Resets") ||
              full.includes("%")
            ) {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(cleanupAndResolve, 1200);
            }
          });

          // Wait a tick then send /usage
          setTimeout(() => {
            try {
              proc?.write("/usage\r");
            } catch {
              // Ignore
            }
          }, 1500);

          proc.onExit(() => {
            if (settleTimer) clearTimeout(settleTimer);
            clearTimeout(globalTimer);
            resolve(full);
          });
        } catch {
          if (settleTimer) clearTimeout(settleTimer);
          clearTimeout(globalTimer);
          resolve(full);
        }
      });
    } catch (err) {
      logger.debug({ err }, "Claude PTY usage probe encountered error");
    }

    const parsed = parseUsageText(ptyOutput);
    if (parsed.weeklyUsedPct !== null || parsed.weeklyResetAt !== null || parsed.window5hUsedPct !== null) {
      return {
        provider: "claude",
        probedAt: new Date(startTime),
        source: "cli_probe",
        buckets: parsed.buckets,
        weeklyUsedPct: parsed.weeklyUsedPct,
        weeklyResetAt: parsed.weeklyResetAt,
        window5hUsedPct: parsed.window5hUsedPct,
        window5hResetAt: parsed.window5hResetAt,
        rawSnippet: ptyOutput.slice(0, 300)
      };
    }

    // 2. Fallback to QuotaGuard scan
    try {
      const qg = new QuotaGuard({
        claudeMaxSessionBudgetUsd: 25,
        stopAtFiveHourQuotaPct: 90,
        stopAtWeeklyQuotaPct: 95
      });
      const usage = qg.scanLogs();
      const estimated5hCapUsd = 20.0;
      const window5hPct = Math.min(100, Math.round((usage.cost5hUsd / estimated5hCapUsd) * 100));

      return {
        provider: "claude",
        probedAt: new Date(startTime),
        source: "local_logs",
        buckets: [
          {
            id: "rolling_5h",
            role: "sub_window",
            scope: "account",
            model: null,
            windowType: "rolling",
            durationHours: 5,
            usedPct: window5hPct,
            resetAt: null,
            confidence: "medium"
          }
        ],
        weeklyUsedPct: null,
        weeklyResetAt: null,
        window5hUsedPct: window5hPct,
        window5hResetAt: null
      };
    } catch {
      // 3. Clean fallback
      return {
        provider: "claude",
        probedAt: new Date(startTime),
        source: "fallback_manual",
        buckets: [],
        weeklyUsedPct: null,
        weeklyResetAt: null,
        window5hUsedPct: null,
        window5hResetAt: null
      };
    }
  }

  public async runAudit(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      model: options.model ?? "opus",
      allowedTools: "Read,Glob,Grep"
    });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      model: options.model ?? this.defaultModel,
      allowedTools: "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(pnpm:*),Bash(npx:*),Bash(pytest:*),Bash(go test:*)"
    });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      model: options.model ?? this.defaultModel,
      allowedTools: "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(pnpm:*),Bash(npx:*),Bash(pytest:*),Bash(go test:*)"
    });
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args: string[] = ["-p", prompt];

    const model = options.model ?? this.defaultModel;
    args.push("--model", model);
    args.push("--output-format", "stream-json");
    args.push("--verbose");

    if (options.extraFlags && options.extraFlags.length > 0) {
      args.push(...options.extraFlags);
    }

    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }
    if (options.maxBudgetUsd) {
      args.push("--max-budget-usd", String(options.maxBudgetUsd));
    }
    if (options.allowedTools) {
      args.push("--allowedTools", options.allowedTools);
    }

    let fullOutput = "";
    let fullStderr = "";
    let rateLimited = false;
    let rateLimitReset: string | undefined;
    let rateLimitType: "5h" | "weekly" | undefined;

    const rateLimitPatterns = [
      /rate_limit_error/i,
      /5-hour limit/i,
      /weekly limit/i,
      /usage limit reached/i,
      /overloaded_error/i,
      /\b429\b/
    ];

    const checkForRateLimit = (text: string) => {
      for (const pattern of rateLimitPatterns) {
        if (pattern.test(text)) {
          rateLimited = true;
          if (/weekly limit/i.test(text)) {
            rateLimitType = "weekly";
          } else if (/5-hour/i.test(text)) {
            rateLimitType = "5h";
          }
          const resetMatch = text.match(/resets?\s+(?:at\s+|in\s+)?([^\n,.]+)/i);
          if (resetMatch?.[1]) {
            rateLimitReset = resetMatch[1].trim();
          }
          break;
        }
      }
    };

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
          ...process.env,
          CI: "1"
        }
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        fullOutput += str;
        options.onChunk?.(str);
        checkForRateLimit(str);
      });

      subprocess.stderr?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        fullStderr += str;
        checkForRateLimit(str);
      });

      const result = await subprocess;
      const durationMs = Date.now() - startTime;
      const extracted = extractTextFromClaudeStream(fullOutput);

      if (rateLimited) {
        logger.warn({ rateLimitReset, rateLimitType }, "Claude Code hit rate limit");
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: extracted.text,
          error: fullStderr,
          rateLimitReset,
          rateLimitType,
          metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
        };
      }

      const signal = parseExitSignal(extracted.text);
      const digest = parseDigest(extracted.text);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: extracted.text,
          blockedReason: signal.reason,
          metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
        };
      }

      if (result.exitCode === 0 && signal.status === "DONE") {
        return {
          exitCode: 0,
          status: "DONE",
          digest,
          output: extracted.text,
          metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
        };
      }

      return {
        exitCode: result.exitCode ?? 1,
        status: "FAILED",
        digest,
        output: extracted.text,
        error: signal.status === null ? "Missing <WET_EXIT_SIGNAL status=\"DONE\"/> marker" : fullStderr,
        metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      checkForRateLimit(fullStderr + (err?.message ?? ""));
      const extracted = extractTextFromClaudeStream(fullOutput);

      if (rateLimited) {
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: extracted.text,
          error: fullStderr,
          rateLimitReset,
          rateLimitType,
          metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
        };
      }

      return {
        exitCode: err?.exitCode ?? 1,
        status: "FAILED",
        digest: parseDigest(extracted.text),
        output: extracted.text,
        error: err?.message || String(err),
        metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
      };
    }
  }
}
