import { execa } from "execa";
import {
  type AgentAdapter,
  type AgentExecutionOptions,
  type ExecutionResult,
  parseExitSignal,
  parseDigest,
  extractTextFromClaudeStream
} from "./agent-adapter.js";
import { logger } from "../utils/logger.js";

export interface ClaudeAdapterConfig {
  binary?: string;
  defaultModel?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  public readonly name = "claude" as const;
  private readonly binary: string;
  private readonly defaultModel: string;

  constructor(config: ClaudeAdapterConfig = {}) {
    this.binary = config.binary ?? "claude";
    this.defaultModel = config.defaultModel ?? "sonnet";
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args: string[] = ["-p", prompt];

    const model = options.model ?? this.defaultModel;
    args.push("--model", model);
    args.push("--output-format", "stream-json");
    args.push("--verbose");

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
          const resetMatch = text.match(/resets?\s+(?:at\s+)?([^\n,.]+)/i);
          if (resetMatch?.[1]) {
            rateLimitReset = resetMatch[1].trim();
          }
          break;
        }
      }
    };

    try {
      const subprocess = execa(this.binary, args, {
        cwd: options.cwd,
        timeout: options.timeoutSec ? options.timeoutSec * 1000 : undefined,
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
        logger.warn({ rateLimitReset }, "Claude Code hit rate limit");
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: extracted.text,
          error: fullStderr,
          rateLimitReset,
          metrics: { durationMs, estimatedCostUsd: extracted.costUsd }
        };
      }

      // Dual-Condition Exit Gate on extracted text
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

      // Exit code 0 without signal or non-zero exit code
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
