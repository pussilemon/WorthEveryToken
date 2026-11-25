import pty from "node-pty";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import {
  type AgentAdapter,
  type AgentExecutionOptions,
  type ExecutionResult,
  parseExitSignal,
  parseDigest
} from "./agent-adapter.js";
import { logger } from "../utils/logger.js";

export interface AgyAdapterConfig {
  binary?: string;
  usePty?: boolean;
  disableSlowMcp?: boolean;
  extraArgs?: string[];
  wallClockTimeoutSec?: number;
  silenceWatchdogSec?: number;
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
  public readonly name = "agy" as const;
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

  public async execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const args = ["-p", prompt, ...this.extraArgs];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color"
    };

    if (this.disableSlowMcp) {
      env.DISABLE_SLOW_MCP = "1";
      env.AGY_HEADLESS = "1";
    }

    const wallClockSec = options.timeoutSec ?? this.wallClockTimeoutSec;
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

            if (exitCode === 0 && signal.status === "DONE" && digest !== null) {
              return resolve({
                exitCode: 0,
                status: "DONE",
                digest,
                output: normalized,
                metrics: { durationMs }
              });
            }

            return resolve({
              exitCode: exitCode ?? 1,
              status: "FAILED",
              digest,
              output: normalized,
              error: digest === null ? "Missing or invalid <WET_DIGEST> block" : "Non-zero exit code or missing exit signal",
              metrics: { durationMs }
            });
          });
        } catch (err: any) {
          cleanupTimers();
          const durationMs = Date.now() - startTime;
          const normalized = normalizeAgyOutput(rawFullOutput);
          resolve({
            exitCode: 1,
            status: "FAILED",
            digest: null,
            output: normalized,
            error: err?.message || String(err),
            metrics: { durationMs }
          });
        }
      });
    }

    // Fallback if usePty is disabled
    try {
      const subprocess = execa(this.binary, args, {
        cwd: options.cwd,
        timeout: wallClockSec * 1000,
        env
      });

      subprocess.stdout?.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        rawFullOutput += str;
        options.onChunk?.(str);
      });

      const result = await subprocess;
      const durationMs = Date.now() - startTime;
      const normalized = normalizeAgyOutput(rawFullOutput);
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

      if (result.exitCode === 0 && signal.status === "DONE" && digest !== null) {
        return {
          exitCode: 0,
          status: "DONE",
          digest,
          output: normalized,
          metrics: { durationMs }
        };
      }

      return {
        exitCode: result.exitCode ?? 1,
        status: "FAILED",
        digest,
        output: normalized,
        error: digest === null ? "Missing or invalid <WET_DIGEST> block" : "Failed exit check",
        metrics: { durationMs }
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const normalized = normalizeAgyOutput(rawFullOutput);
      return {
        exitCode: err?.exitCode ?? 1,
        status: "FAILED",
        digest: parseDigest(normalized),
        output: normalized,
        error: err?.message || String(err),
        metrics: { durationMs }
      };
    }
  }

  public saveAgyLog(taskId: string, logDir: string, fullOutput: string): void {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${taskId}-agy.log`);
      fs.writeFileSync(logFile, fullOutput, "utf-8");
    } catch (err) {
      logger.warn({ taskId, err }, "Failed to save agy log file");
    }
  }
}
