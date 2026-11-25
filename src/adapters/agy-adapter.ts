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

    let fullOutput = "";
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
            fullOutput += data;
            options.onChunk?.(data);
            resetSilenceWatchdog();
          });

          ptyProcess.onExit(({ exitCode }) => {
            cleanupTimers();
            const durationMs = Date.now() - startTime;

            if (killedByWatchdog) {
              return resolve({
                exitCode: 124,
                status: "FAILED",
                digest: null,
                output: fullOutput,
                error: `Agy process terminated by silence watchdog after ${silenceSec}s with no output`,
                metrics: { durationMs }
              });
            }

            if (killedByWallClock) {
              return resolve({
                exitCode: 124,
                status: "FAILED",
                digest: null,
                output: fullOutput,
                error: `Agy process exceeded wall-clock timeout of ${wallClockSec}s`,
                metrics: { durationMs }
              });
            }

            const signal = parseExitSignal(fullOutput);
            const digest = parseDigest(fullOutput);

            if (signal.status === "BLOCKED") {
              return resolve({
                exitCode: 0,
                status: "BLOCKED",
                digest,
                output: fullOutput,
                blockedReason: signal.reason,
                metrics: { durationMs }
              });
            }

            if (exitCode === 0 && signal.status === "DONE" && digest !== null) {
              return resolve({
                exitCode: 0,
                status: "DONE",
                digest,
                output: fullOutput,
                metrics: { durationMs }
              });
            }

            return resolve({
              exitCode: exitCode ?? 1,
              status: "FAILED",
              digest,
              output: fullOutput,
              error: digest === null ? "Missing or invalid <WQB_DIGEST> block" : "Non-zero exit code or missing exit signal",
              metrics: { durationMs }
            });
          });
        } catch (err: any) {
          cleanupTimers();
          const durationMs = Date.now() - startTime;
          resolve({
            exitCode: 1,
            status: "FAILED",
            digest: null,
            output: fullOutput,
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
        fullOutput += str;
        options.onChunk?.(str);
      });

      const result = await subprocess;
      const durationMs = Date.now() - startTime;
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

      if (result.exitCode === 0 && signal.status === "DONE" && digest !== null) {
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
        error: "Failed exit check or missing digest block",
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
