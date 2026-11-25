import pty from "node-pty";
import { execa, execaSync } from "execa";
import fs from "node:fs";
import path from "node:path";
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

export interface AgyAdapterConfig {
  binary?: string;
  usePty?: boolean;
  disableSlowMcp?: boolean;
  extraArgs?: string[];
  wallClockTimeoutSec?: number;
  silenceWatchdogSec?: number;
}

export function parseAgyModelsOutput(rawOutput: string): string[] {
  const ansiRegex = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const clean = rawOutput
    .replace(ansiRegex, "")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")
    .replace(/Fetching available models\.\.\./g, "");
  const lines = clean.split("\n");
  const models: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9_.-]+)\s+/);
    if (match && match[1]) {
      models.push(match[1]);
    }
  }
  return models;
}

export function selectTopAgyModel(models: string[], override?: string): string | null {
  if (override && override !== "auto") {
    return override;
  }
  if (!models || models.length === 0) {
    return null;
  }

  const scoreModel = (name: string): number => {
    const lower = name.toLowerCase();
    // 1. Top reasoning (xhigh / thinking / opus)
    if (lower.includes("xhigh")) return 100;
    if (lower.includes("thinking") && lower.includes("opus")) return 95;
    if (lower.includes("opus")) return 90;
    if (lower.includes("thinking")) return 88;

    // 2. Flagship high (high / sonnet)
    if (lower.includes("hydrogen-high")) return 80;
    if (lower.includes("sonnet")) return 78;
    if (lower.includes("high")) return 75;

    // 3. Other medium / flash / low
    if (lower.includes("medium")) return 50;
    if (lower.includes("flash")) return 40;
    if (lower.includes("low")) return 20;

    return 10;
  };

  let bestModel: string | null = null;
  let bestScore = -1;

  for (const model of models) {
    const score = scoreModel(model);
    if (score > bestScore) {
      bestScore = score;
      bestModel = model;
    }
  }

  return bestModel;
}

let cachedModels: string[] | null = null;
let cachedModelsExpiresAt = 0;

export function clearAgyModelsCache(): void {
  cachedModels = null;
  cachedModelsExpiresAt = 0;
}

export async function discoverAgyModels(binary = "agy"): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now < cachedModelsExpiresAt) {
    return cachedModels;
  }
  try {
    const { stdout } = await execa(binary, ["models"], { timeout: 10000 });
    const models = parseAgyModelsOutput(stdout);
    if (models.length > 0) {
      cachedModels = models;
      cachedModelsExpiresAt = now + 60 * 60 * 1000;
      return models;
    }
  } catch (err) {
    logger.debug({ err }, "Failed to discover models via agy models");
  }
  return cachedModels ?? [];
}

export function normalizeAgyOutput(rawOutput: string): string {
  // Strip ANSI/CSI and OSC escape sequences
  const ansiRegex = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const oscRegex = /\u001b\][^\u0007]*\u0007/g;
  let clean = rawOutput.replace(ansiRegex, "").replace(oscRegex, "");

  // Normalize line endings
  clean = clean.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Check if there is an outer JSON wrapper
  const tryUnwrapJson = (str: string): string | null => {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.response === "string") return parsed.response;
        if (typeof parsed.result === "string") return parsed.result;
        if (typeof parsed.text === "string") return parsed.text;
        if (typeof parsed.content === "string") return parsed.content;
        if (typeof parsed.output === "string") return parsed.output;
        if (parsed.message && typeof parsed.message.content === "string") return parsed.message.content;
      }
    } catch {
      // Not direct JSON
    }
    return null;
  };

  const directUnwrap = tryUnwrapJson(clean);
  if (directUnwrap) {
    return directUnwrap;
  }

  // Look for JSON object in last line or block
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(i).join("\n").trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      const unwrapped = tryUnwrapJson(candidate);
      if (unwrapped) {
        return unwrapped;
      }
    }
  }

  return clean;
}

export class AgyAdapter implements AgentAdapter {
  public readonly provider = "agy" as const;
  private readonly binary: string;
  private readonly usePty: boolean;
  private readonly disableSlowMcp: boolean;
  private readonly extraArgs: string[];
  private readonly wallClockTimeoutSec: number;
  private readonly silenceWatchdogSec: number;

  constructor(config: AgyAdapterConfig = {}) {
    this.binary = config.binary ?? "agy";
    this.usePty = config.usePty ?? true;
    this.disableSlowMcp = config.disableSlowMcp ?? true;
    this.extraArgs = config.extraArgs ?? ["--output-format", "json"];
    this.wallClockTimeoutSec = config.wallClockTimeoutSec ?? 180;
    this.silenceWatchdogSec = config.silenceWatchdogSec ?? 60;
  }

  public async checkInstalled(): Promise<{ available: boolean; version?: string; binaryPath?: string }> {
    try {
      const { stdout } = await execa(this.binary, ["--version"]);
      return { available: true, version: stdout.trim(), binaryPath: this.binary };
    } catch {
      return { available: false };
    }
  }

  public async discoverTopModel(override?: string): Promise<string | null> {
    const models = await discoverAgyModels(this.binary);
    return selectTopAgyModel(models, override);
  }

  public getTopModelProfile(config: WetGlobalConfig): { model: string; effort?: string; extraFlags: string[] } {
    const override = config.model_override;
    let resolvedModel: string | null = null;

    if (override && override !== "auto") {
      resolvedModel = override;
    } else if (cachedModels && cachedModels.length > 0) {
      resolvedModel = selectTopAgyModel(cachedModels, override);
    } else {
      try {
        const { stdout } = execaSync(this.binary, ["models"], { timeout: 4000 });
        const models = parseAgyModelsOutput(stdout);
        if (models.length > 0) {
          cachedModels = models;
          cachedModelsExpiresAt = Date.now() + 60 * 60 * 1000;
          resolvedModel = selectTopAgyModel(models, override);
        }
      } catch {
        // Fallback to null
      }
    }

    const model = resolvedModel ?? "auto";
    const effort = config.reasoning_effort ?? "max";
    const extraFlags: string[] = ["--effort", effort];
    return { model, effort, extraFlags };
  }

  public async probeUsage(): Promise<UsageSnapshot> {
    const startTime = Date.now();
    // agy 1.5.17 does not support 'status' or native usage inspection commands.
    // Instantaneous, non-failing fallback snapshot:
    return {
      provider: "agy",
      probedAt: new Date(startTime),
      source: "fallback_manual",
      buckets: [],
      weeklyUsedPct: null,
      weeklyResetAt: null,
      window5hUsedPct: null,
      window5hResetAt: null,
      rawSnippet: ""
    };
  }

  public async runAudit(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const extraFlags = [...(options.extraFlags ?? [])];
    if (!extraFlags.includes("--mode")) {
      extraFlags.push("--mode", "plan");
    }
    // Filter out --dangerously-skip-permissions and --mode accept-edits if present
    const filteredFlags: string[] = [];
    for (let i = 0; i < extraFlags.length; i++) {
      const f = extraFlags[i]!;
      if (f === "--dangerously-skip-permissions") continue;
      if (f === "--mode" && extraFlags[i + 1] === "accept-edits") {
        filteredFlags.push("--mode", "plan");
        i++;
        continue;
      }
      filteredFlags.push(f);
    }

    return this.execute(prompt, {
      ...options,
      extraFlags: filteredFlags,
      cwd: workdir,
      phase: "audit"
    });
  }

  public async runTask(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const extraFlags = [...(options.extraFlags ?? [])];
    if (!extraFlags.includes("--mode")) {
      extraFlags.push("--mode", "accept-edits");
    }
    if (!extraFlags.includes("--dangerously-skip-permissions")) {
      extraFlags.push("--dangerously-skip-permissions");
    }
    return this.execute(prompt, {
      ...options,
      extraFlags,
      cwd: workdir,
      phase: "execute"
    });
  }

  public async runRepair(prompt: string, workdir: string, options: AgentExecutionOptions = {}): Promise<ExecutionResult> {
    const extraFlags = [...(options.extraFlags ?? [])];
    if (!extraFlags.includes("--mode")) {
      extraFlags.push("--mode", "accept-edits");
    }
    if (!extraFlags.includes("--dangerously-skip-permissions")) {
      extraFlags.push("--dangerously-skip-permissions");
    }
    return this.execute(prompt, {
      ...options,
      extraFlags,
      cwd: workdir,
      phase: "repair"
    });
  }

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args = ["-p", prompt, ...this.extraArgs, ...(options.extraFlags ?? [])];
    if (options.model && options.model !== "auto") {
      args.push("--model", options.model);
    }
    if (!args.includes("--effort")) {
      args.push("--effort", "max");
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color"
    };

    if (this.disableSlowMcp) {
      env.DISABLE_SLOW_MCP = "1";
      env.AGY_HEADLESS = "1";
    }

    let wallClockSec = options.timeoutSec ?? this.wallClockTimeoutSec;
    if (options.deadlineAt) {
      const remainingSec = Math.floor((options.deadlineAt.getTime() - Date.now()) / 1000);
      if (remainingSec <= 0) {
        return {
          exitCode: 124,
          status: "FAILED",
          digest: null,
          output: "",
          error: "Process not started: hard deadline already expired",
          metrics: { durationMs: 0 }
        };
      }
      wallClockSec = Math.min(wallClockSec, remainingSec);
    }
    const silenceSec = this.silenceWatchdogSec;

    let rawFullOutput = "";
    let killedByWatchdog = false;
    let killedByWallClock = false;

    if (this.usePty) {
      return new Promise<ExecutionResult>((resolve) => {
        let ptyProcess: pty.IPty | null = null;
        let silenceTimer: NodeJS.Timeout | null = null;
        let wallClockTimer: NodeJS.Timeout | null = null;

        const cleanupTimers = () => {
          if (silenceTimer) clearTimeout(silenceTimer);
          if (wallClockTimer) clearTimeout(wallClockTimer);
        };

        const resetSilenceWatchdog = () => {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            killedByWatchdog = true;
            logger.warn({ silenceSec }, "Agy silence watchdog expired, terminating process (issue #318)");
            try {
              ptyProcess?.kill("SIGKILL");
            } catch {
              // Ignore
            }
          }, silenceSec * 1000);
        };

        wallClockTimer = setTimeout(() => {
          killedByWallClock = true;
          logger.warn({ wallClockSec }, "Agy wall-clock timeout expired, terminating process");
          try {
            ptyProcess?.kill("SIGKILL");
          } catch {
            // Ignore
          }
        }, wallClockSec * 1000);

        try {
          ptyProcess = pty.spawn(this.binary, args, {
            name: "xterm-color",
            cols: 120,
            rows: 40,
            cwd: options.cwd,
            env
          });

          resetSilenceWatchdog();

          ptyProcess.onData((data: string) => {
            rawFullOutput += data;
            options.onChunk?.(data);
            resetSilenceWatchdog();
          });

          ptyProcess.onExit(({ exitCode }) => {
            cleanupTimers();
            const durationMs = Date.now() - startTime;
            const normalized = normalizeAgyOutput(rawFullOutput);

            if (killedByWatchdog) {
              return resolve({
                exitCode: 124,
                status: "FAILED",
                digest: null,
                output: normalized,
                error: `Agy process terminated by silence watchdog after ${silenceSec}s with no output`,
                metrics: { durationMs }
              });
            }

            if (killedByWallClock) {
              return resolve({
                exitCode: 124,
                status: "FAILED",
                digest: null,
                output: normalized,
                error: `Agy process exceeded wall-clock timeout of ${wallClockSec}s`,
                metrics: { durationMs }
              });
            }

            // Check rate limits
            const isRateLimit =
              normalized.includes("rate limit") ||
              normalized.includes("429") ||
              normalized.includes("quota exceeded") ||
              normalized.includes("RESOURCE_EXHAUSTED");

            if (isRateLimit) {
              const parsed = parseUsageText(normalized);
              const isWeekly = normalized.includes("weekly");
              return resolve({
                exitCode: 429,
                status: "RATE_LIMITED",
                rateLimitType: isWeekly ? "weekly" : "5h",
                rateLimitReset: parsed.window5hResetAt?.toISOString() ?? parsed.weeklyResetAt?.toISOString(),
                digest: null,
                output: normalized,
                error: "Rate limit reached in agy",
                metrics: { durationMs }
              });
            }

            const signal = parseExitSignal(normalized);
            const digest = parseDigest(normalized);

            if (signal.status === "BLOCKED") {
              return resolve({
                exitCode: 0,
                status: "BLOCKED",
                digest,
                output: normalized,
                blockedReason: signal.reason,
                metrics: { durationMs }
              });
            }

            if (exitCode === 0 && signal.status === "DONE") {
              const phase = options.phase ?? "execute";
              if (phase === "audit" || phase === "repair" || digest !== null) {
                return resolve({
                  exitCode: 0,
                  status: "DONE",
                  digest,
                  output: normalized,
                  metrics: { durationMs }
                });
              }

              // Phase === "execute" with missing digest: provide synthetic fallback
              logger.warn({ taskId: options.taskId }, "Agy finished with status=DONE but missing <WET_DIGEST>. Generating synthetic fallback digest.");
              return resolve({
                exitCode: 0,
                status: "DONE",
                digest: {
                  files_changed: [],
                  summary: "Completed without structured digest",
                  tests_added: 0,
                  risks: []
                },
                output: normalized,
                metrics: { durationMs }
              });
            }

            return resolve({
              exitCode: exitCode ?? 1,
              status: "FAILED",
              digest,
              output: normalized,
              error: `Agy exited with code ${exitCode} without valid completion protocol`,
              metrics: { durationMs }
            });
          });
        } catch (err: any) {
          cleanupTimers();
          resolve({
            exitCode: 1,
            status: "FAILED",
            digest: null,
            output: rawFullOutput,
            error: err?.message || String(err),
            metrics: { durationMs: Date.now() - startTime }
          });
        }
      });
    }

    // Standard non-PTY fallback
    try {
      const subprocess = execa(this.binary, args, {
        cwd: options.cwd,
        env,
        timeout: wallClockSec * 1000
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        rawFullOutput += text;
        options.onChunk?.(text);
      });

      subprocess.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        rawFullOutput += text;
        options.onChunk?.(text);
      });

      const { exitCode } = await subprocess;
      const durationMs = Date.now() - startTime;
      const normalized = normalizeAgyOutput(rawFullOutput);

      const isRateLimit =
        normalized.includes("rate limit") ||
        normalized.includes("429") ||
        normalized.includes("quota exceeded") ||
        normalized.includes("RESOURCE_EXHAUSTED");

      if (isRateLimit) {
        const parsed = parseUsageText(normalized);
        const isWeekly = normalized.includes("weekly");
        return {
          exitCode: 429,
          status: "RATE_LIMITED",
          rateLimitType: isWeekly ? "weekly" : "5h",
          rateLimitReset: parsed.window5hResetAt?.toISOString() ?? parsed.weeklyResetAt?.toISOString(),
          digest: null,
          output: normalized,
          error: "Rate limit reached in agy",
          metrics: { durationMs }
        };
      }

      const signal = parseExitSignal(normalized);
      const digest = parseDigest(normalized);

      if (signal.status === "BLOCKED") {
        return {
          exitCode: 0,
          status: "BLOCKED",
          digest,
          output: normalized,
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
            output: normalized,
            metrics: { durationMs }
          };
        }

        // Phase === "execute" with missing digest: provide synthetic fallback
        logger.warn(
          { taskId: options.taskId },
          "Agy finished with status=DONE but missing <WET_DIGEST>. Generating synthetic fallback digest."
        );
        return {
          exitCode: 0,
          status: "DONE",
          digest: {
            files_changed: [],
            summary: "Completed without structured digest",
            tests_added: 0,
            risks: []
          },
          output: normalized,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: exitCode ?? 1,
        status: "FAILED",
        digest,
        output: normalized,
        error: `Agy exited with code ${exitCode} without valid completion protocol`,
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const normalized = normalizeAgyOutput(rawFullOutput);
      return {
        exitCode: 1,
        status: "FAILED",
        digest: null,
        output: normalized,
        error: err?.message || String(err),
        metrics: { durationMs }
      };
    }
  }

  public saveAgyLog(taskId: string, logsDir = ".wet/logs", rawOutput: string): void {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, `agy-task-${taskId}.log`);
      fs.writeFileSync(logFile, rawOutput, "utf-8");
      logger.debug({ logFile }, "Saved raw Agy task execution log");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to persist Agy log file");
    }
  }
}
