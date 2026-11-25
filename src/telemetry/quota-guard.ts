import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "../utils/logger.js";

export interface QuotaState {
  fileOffsets: Record<string, number>;
  sessionCostUsd: number;
  tokens5h: number;
  cost5hUsd: number;
  tokens7d: number;
  cost7dUsd: number;
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
    stateFilePath = ".wqb/quota-state.json",
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
          tokens5h: parsed.tokens5h ?? 0,
          cost5hUsd: parsed.cost5hUsd ?? 0,
          tokens7d: parsed.tokens7d ?? 0,
          cost7dUsd: parsed.cost7dUsd ?? 0,
          lastUpdated: parsed.lastUpdated ?? new Date().toISOString()
        };
      } catch {
        // Fallback to initial
      }
    }
    return {
      fileOffsets: {},
      sessionCostUsd: 0,
      tokens5h: 0,
      cost5hUsd: 0,
      tokens7d: 0,
      cost7dUsd: 0,
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

  public scanLogs(): UsageWindow {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    let deltaTokens5h = 0;
    let deltaCost5hUsd = 0;
    let deltaTokens7d = 0;
    let deltaCost7dUsd = 0;

    if (!fs.existsSync(this.claudeProjectsDir)) {
      return {
        tokens5h: this.state.tokens5h,
        cost5hUsd: this.state.cost5hUsd,
        tokens7d: this.state.tokens7d,
        cost7dUsd: this.state.cost7dUsd,
        sessionCostUsd: this.state.sessionCostUsd
      };
    }

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
            const entryTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : now;
            const inputTokens = entry.usage?.input_tokens ?? entry.input_tokens ?? 0;
            const outputTokens = entry.usage?.output_tokens ?? entry.output_tokens ?? 0;
            const totalTokens = inputTokens + outputTokens;

            // Approximate Claude 3.5 Sonnet pricing: $3 / 1M input, $15 / 1M output
            const estimatedCost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

            if (entryTimestamp >= sevenDaysAgo) {
              deltaTokens7d += totalTokens;
              deltaCost7dUsd += estimatedCost;
            }
            if (entryTimestamp >= fiveHoursAgo) {
              deltaTokens5h += totalTokens;
              deltaCost5hUsd += estimatedCost;
            }

            this.state.sessionCostUsd += estimatedCost;
          } catch {
            // Skip unparseable lines
          }
        }
      } catch (err) {
        logger.debug({ file, err }, "Error reading jsonl log file");
      }
    }

    this.state.tokens5h += deltaTokens5h;
    this.state.cost5hUsd += deltaCost5hUsd;
    this.state.tokens7d += deltaTokens7d;
    this.state.cost7dUsd += deltaCost7dUsd;
    this.state.lastUpdated = new Date().toISOString();
    this.saveState();

    return {
      tokens5h: this.state.tokens5h,
      cost5hUsd: this.state.cost5hUsd,
      tokens7d: this.state.tokens7d,
      cost7dUsd: this.state.cost7dUsd,
      sessionCostUsd: this.state.sessionCostUsd
    };
  }

  public shouldStop(): { stop: boolean; reason?: string } {
    const usage = this.scanLogs();

    if (usage.sessionCostUsd >= this.limits.claudeMaxSessionBudgetUsd) {
      return {
        stop: true,
        reason: `Session cost ($${usage.sessionCostUsd.toFixed(2)}) reached max budget ($${this.limits.claudeMaxSessionBudgetUsd.toFixed(2)})`
      };
    }

    // Typical standard limit threshold: estimate 5h cap ~$20 or proportional
    const estimated5hCapUsd = 20.0;
    const pct5h = (usage.cost5hUsd / estimated5hCapUsd) * 100;
    if (pct5h >= this.limits.stopAtFiveHourQuotaPct) {
      return {
        stop: true,
        reason: `5-hour window usage (${pct5h.toFixed(1)}%) reached safety threshold (${this.limits.stopAtFiveHourQuotaPct}%)`
      };
    }

    return { stop: false };
  }

  public addSessionCost(amountUsd: number): void {
    this.state.sessionCostUsd += amountUsd;
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
