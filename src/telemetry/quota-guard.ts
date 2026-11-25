import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../utils/logger.js";

export interface QuotaUsageEvent {
  ts: number;
  costUsd: number;
  tokens: number;
}

export interface QuotaState {
  fileOffsets: Record<string, number>;
  sessionCostUsd: number;
  events: QuotaUsageEvent[];
  lastUpdated: string;
}

export interface QuotaGuardLimits {
  claudeMaxSessionBudgetUsd: number;
  stopAtFiveHourQuotaPct: number;
  stopAtWeeklyQuotaPct: number;
}

export interface UsageWindow {
  tokens5h: number;
  cost5hUsd: number;
  tokens7d: number;
  cost7dUsd: number;
  sessionCostUsd: number;
}

export class QuotaGuard {
  private readonly stateFilePath: string;
  private readonly limits: QuotaGuardLimits;
  private state: QuotaState;
  private readonly claudeProjectsDir: string;

  constructor(
    limits: QuotaGuardLimits,
    stateFilePath = ".wet/quota-state.json",
    claudeProjectsDir?: string
  ) {
    this.limits = limits;
    this.stateFilePath = path.resolve(stateFilePath);
    this.claudeProjectsDir =
      claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
    this.state = this.loadState();
  }

  private loadState(): QuotaState {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          fileOffsets: parsed.fileOffsets ?? {},
          sessionCostUsd: parsed.sessionCostUsd ?? 0,
          events: Array.isArray(parsed.events) ? parsed.events : [],
          lastUpdated: parsed.lastUpdated ?? new Date().toISOString()
        };
      } catch {
        // Fallback to initial
      }
    }
    return {
      fileOffsets: {},
      sessionCostUsd: 0,
      events: [],
      lastUpdated: new Date().toISOString()
    };
  }

  public saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      logger.warn({ err }, "Failed to save quota state file");
    }
  }

  public scanLogs(now = Date.now()): UsageWindow {
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;

    if (fs.existsSync(this.claudeProjectsDir)) {
      const jsonlFiles = this.findJsonlFiles(this.claudeProjectsDir);

      for (const file of jsonlFiles) {
        try {
          const stat = fs.statSync(file);
          const lastOffset = this.state.fileOffsets[file] ?? 0;

          if (stat.size <= lastOffset) {
            continue;
          }

          const fd = fs.openSync(file, "r");
          const bufferSize = stat.size - lastOffset;
          const buffer = Buffer.alloc(bufferSize);
          fs.readSync(fd, buffer, 0, bufferSize, lastOffset);
          fs.closeSync(fd);

          this.state.fileOffsets[file] = stat.size;

          const lines = buffer.toString("utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const entry = JSON.parse(trimmed);
              const entryTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : stat.mtimeMs || now;
              const usage = entry.usage ?? entry.message?.usage;

              if (usage) {
                const inputTokens = usage.input_tokens ?? 0;
                const outputTokens = usage.output_tokens ?? 0;
                const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
                const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

                const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

                // Approximate Sonnet pricing
                const costUsd =
                  (inputTokens / 1_000_000) * 3.0 +
                  (outputTokens / 1_000_000) * 15.0 +
                  (cacheCreationTokens / 1_000_000) * 3.75 +
                  (cacheReadTokens / 1_000_000) * 0.30;

                this.state.events.push({
                  ts: entryTimestamp,
                  costUsd,
                  tokens: totalTokens
                });

                this.state.sessionCostUsd += costUsd;
              }
            } catch {
              // Skip unparseable lines
            }
          }
        } catch (err) {
          logger.debug({ file, err }, "Error reading jsonl log file");
        }
      }
    }

    // Prune events older than 7 days
    this.state.events = this.state.events.filter((e) => e.ts >= sevenDaysAgo);

    let tokens5h = 0;
    let cost5hUsd = 0;
    let tokens7d = 0;
    let cost7dUsd = 0;

    for (const event of this.state.events) {
      tokens7d += event.tokens;
      cost7dUsd += event.costUsd;

      if (event.ts >= fiveHoursAgo) {
        tokens5h += event.tokens;
        cost5hUsd += event.costUsd;
      }
    }

    this.state.lastUpdated = new Date().toISOString();
    this.saveState();

    return {
      tokens5h,
      cost5hUsd,
      tokens7d,
      cost7dUsd,
      sessionCostUsd: this.state.sessionCostUsd
    };
  }

  public shouldStop(): { stop: boolean; reason?: string } {
    const usage = this.scanLogs();

    // 1. Session cost limit
    if (usage.sessionCostUsd >= this.limits.claudeMaxSessionBudgetUsd) {
      return {
        stop: true,
        reason: `Session cost ($${usage.sessionCostUsd.toFixed(2)}) reached max budget ($${this.limits.claudeMaxSessionBudgetUsd.toFixed(2)})`
      };
    }

    // 2. 5-hour window safety threshold
    const estimated5hCapUsd = 20.0;
    const pct5h = (usage.cost5hUsd / estimated5hCapUsd) * 100;
    if (pct5h >= this.limits.stopAtFiveHourQuotaPct) {
      return {
        stop: true,
        reason: `5-hour window usage (${pct5h.toFixed(1)}%) reached safety threshold (${this.limits.stopAtFiveHourQuotaPct}%)`
      };
    }

    // 3. Weekly quota safety threshold
    const estimatedWeeklyCapUsd = 100.0;
    const pct7d = (usage.cost7dUsd / estimatedWeeklyCapUsd) * 100;
    if (pct7d >= this.limits.stopAtWeeklyQuotaPct) {
      return {
        stop: true,
        reason: `Weekly window usage (${pct7d.toFixed(1)}%) reached safety threshold (${this.limits.stopAtWeeklyQuotaPct}%)`
      };
    }

    return { stop: false };
  }

  public addSessionCost(amountUsd: number): void {
    this.state.sessionCostUsd += amountUsd;
    this.state.events.push({
      ts: Date.now(),
      costUsd: amountUsd,
      tokens: 0
    });
    this.saveState();
  }

  private findJsonlFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.findJsonlFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore directory read errors
    }
    return results;
  }
}
