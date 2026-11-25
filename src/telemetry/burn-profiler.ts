import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import type { Task } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface AnomalyReport {
  hasAnomaly: boolean;
  loopDetected: boolean;
  redundantRetries: number;
  unusualBurnRate: boolean;
  reason?: string;
}

export class BurnProfiler {
  private readonly vendorAgentburnPath: string;

  constructor(vendorAgentburnPath = "vendor/agentburn") {
    this.vendorAgentburnPath = path.resolve(vendorAgentburnPath);
  }

  public async profileTask(task: Task, recentTasks: Task[]): Promise<AnomalyReport> {
    // 1. Check for repetitive identical errors / retry loops
    if (task.retries >= 3 && task.status === "failed") {
      return {
        hasAnomaly: true,
        loopDetected: true,
        redundantRetries: task.retries,
        unusualBurnRate: true,
        reason: `Task ${task.id} failed across ${task.retries} retries with continuous failure`
      };
    }

    // 2. Check for file-level churn loops across recent tasks
    const recentFailures = recentTasks.filter((t) => t.status === "failed").slice(-3);
    if (recentFailures.length >= 3) {
      const allFiles = recentFailures.flatMap((t) => t.target_files);
      const fileCounts = new Map<string, number>();
      for (const f of allFiles) {
        fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
      }
      for (const [file, count] of fileCounts.entries()) {
        if (count >= 3) {
          return {
            hasAnomaly: true,
            loopDetected: true,
            redundantRetries: count,
            unusualBurnRate: true,
            reason: `Repeated failure loop detected on target file: ${file}`
          };
        }
      }
    }

    // 3. If vendor/agentburn is runnable via python, attempt read-only analysis
    if (fs.existsSync(this.vendorAgentburnPath)) {
      try {
        const { stdout } = await execa("python3", ["-m", "agentburn", "--help"], {
          cwd: this.vendorAgentburnPath,
          timeout: 5000
        });
        logger.debug({ stdout: stdout.slice(0, 100) }, "vendor/agentburn CLI is available");
      } catch {
        // Fallback to internal heuristic profiling
      }
    }

    return {
      hasAnomaly: false,
      loopDetected: false,
      redundantRetries: 0,
      unusualBurnRate: false
    };
  }
}
