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
      allowedTools: "read-only"
    });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      allowedTools: "workspace-write"
    });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    return this.execute(prompt, {
      ...options,
      cwd: workdir,
      allowedTools: "workspace-write"
    });
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const isReadOnly = options.allowedTools === "read-only";

    const args = ["exec"];
    if (isReadOnly) {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write", "--full-auto");
    }

    if (options.model) {
      args.push("--model", options.model);
    }
    args.push("-p", prompt);

    let fullOutput = "";
    let fullStderr = "";
    let rateLimited = false;
    let rateLimitReset: string | undefined;
    let rateLimitType: "5h" | "weekly" | undefined;

    try {
      const subprocess = execa(this.binary, args, {
        cwd: options.cwd,
        timeout: options.timeoutSec ? options.timeoutSec * 1000 : 300000,
        env: {
          ...process.env,
          CI: "1"
        }
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        fullOutput += str;
        options.onChunk?.(str);
        if (/rate[_\s]limit|429|quota/i.test(str)) {
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
        if (/rate[_\s]limit|429|quota/i.test(str)) {
          rateLimited = true;
          if (/weekly/i.test(str)) rateLimitType = "weekly";
          else rateLimitType = "5h";
          const match = str.match(/resets?\s+(?:at\s+|in\s+)?([^\n,.]+)/i);
          if (match?.[1]) rateLimitReset = match[1].trim();
        }
      });

      const result = await subprocess;
      const durationMs = Date.now() - startTime;

      if (rateLimited) {
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          digest: null,
          output: fullOutput,
          error: fullStderr,
          rateLimitReset,
          rateLimitType,
          metrics: { durationMs }
        };
      }

      const signal = parseExitSignal(fullOutput);
      const digest = parseDigest(fullOutput);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: fullOutput,
          blockedReason: signal.reason,
          metrics: { durationMs }
        };
      }

      if (result.exitCode === 0 && signal.status === "DONE") {
        return {
          exitCode: 0,
          status: "DONE",
          digest,
          output: fullOutput,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: result.exitCode ?? 1,
        status: "FAILED",
        digest,
        output: fullOutput,
        error: signal.status === null ? "Missing <WET_EXIT_SIGNAL status=\"DONE\"/> marker" : fullStderr,
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      return {
        exitCode: err?.exitCode ?? 1,
        status: "FAILED",
        digest: parseDigest(fullOutput),
        output: fullOutput,
        error: err?.message || String(err),
        metrics: { durationMs }
      };
    }
  }
}
