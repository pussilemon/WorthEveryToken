import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import type { ProviderId, WetGlobalConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface ActivityCheckResult {
  active: boolean;
  reason?: string;
}

export async function hasInteractiveCliProcess(provider: ProviderId): Promise<boolean> {
  try {
    const { stdout } = await execa("ps", ["-eo", "pid,ppid,comm,args"], { timeout: 3000 });
    const currentPid = process.pid;
    const lines = stdout.split("\n");

    const cliRegex = new RegExp(`\\b(${provider})\\b`, "i");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0] ?? "0", 10);
      const ppid = parseInt(parts[1] ?? "0", 10);

      // Exclude self and parent process
      if (pid === currentPid || ppid === currentPid) continue;

      // Exclude wet runner commands or internal stream runners
      if (trimmed.includes("wet") || trimmed.includes("--output-format stream-json") || trimmed.includes("watch")) {
        continue;
      }

      if (cliRegex.test(trimmed)) {
        logger.debug({ line: trimmed }, "Detected active interactive AI process");
        return true;
      }
    }
  } catch {
    // If ps fails, ignore
  }
  return false;
}

export function hasRecentAiLogWrites(userIdleMinutes = 15): boolean {
  try {
    const claudeProjectsDir = path.join(os.homedir(), ".claude/projects");
    if (!fs.existsSync(claudeProjectsDir)) return false;

    const thresholdMs = Date.now() - userIdleMinutes * 60_000;

    const checkDir = (dir: string): boolean => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".wet" && checkDir(fullPath)) return true;
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs > thresholdMs) {
            return true;
          }
        }
      }
      return false;
    };

    return checkDir(claudeProjectsDir);
  } catch {
    return false;
  }
}

export async function hasRecentRepoEdits(repoPath: string, idleMinutes = 10): Promise<boolean> {
  try {
    const thresholdMs = Date.now() - idleMinutes * 60_000;

    // 1. Check uncommitted changes with null-delimiter (-z)
    const { stdout } = await execa("git", ["status", "--porcelain", "-z"], { cwd: repoPath, timeout: 5000 });
    const rawParts = stdout.split("\0");
    const pathsToCheck: string[] = [];

    for (let i = 0; i < rawParts.length; i++) {
      const entry = rawParts[i];
      if (!entry || entry.trim().length === 0) continue;

      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);

      if (filePath && !filePath.startsWith(".wet")) {
        pathsToCheck.push(filePath);
      }

      // If rename/copy, the next token in -z is the target path
      if ((status.includes("R") || status.includes("C")) && i + 1 < rawParts.length) {
        i++;
        const nextPath = rawParts[i];
        if (nextPath && !nextPath.startsWith(".wet")) {
          pathsToCheck.push(nextPath);
        }
      }
    }

    for (const relPath of pathsToCheck) {
      const fullPath = path.resolve(repoPath, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs >= thresholdMs) {
            logger.debug({ relPath, mtimeMs: stats.mtimeMs, thresholdMs }, "Detected active recent repo edit");
            return true;
          }
        }
      } catch {
        // Ignore file access errors
      }
    }

    // 2. Check recent mtime on committed files (excluding .git and .wet)
    const entries = fs.readdirSync(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".wet" || entry.name === "node_modules") continue;
      const fullPath = path.join(repoPath, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.mtimeMs >= thresholdMs) {
          return true;
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore git errors
  }
  return false;
}

export interface QuietHoursOptions {
  enabled: boolean;
  start: string;
  end: string;
  allowDaytimeIfExpiringWithinHours?: number;
  allow_daytime_if_expiring_within_hours?: number;
}

export function isInsideQuietHours(
  now: Date,
  quietHours: QuietHoursOptions,
  hoursUntilExpiry?: number | null
): boolean {
  if (!quietHours.enabled) {
    return true;
  }

  // Weekends are always quiet hours
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return true;
  }

  const allowExpiringHours =
    quietHours.allowDaytimeIfExpiringWithinHours ??
    quietHours.allow_daytime_if_expiring_within_hours ??
    6;

  // If expiring very soon (e.g. <= 6h), daytime work is permitted
  if (
    hoursUntilExpiry !== null &&
    hoursUntilExpiry !== undefined &&
    hoursUntilExpiry <= allowExpiringHours
  ) {
    return true;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startHStr, startMStr] = quietHours.start.split(":");
  const startMinutes = parseInt(startHStr ?? "22", 10) * 60 + parseInt(startMStr ?? "0", 10);

  const [endHStr, endMStr] = quietHours.end.split(":");
  const endMinutes = parseInt(endHStr ?? "8", 10) * 60 + parseInt(endMStr ?? "0", 10);

  // If spans across midnight (e.g. 22:00 -> 08:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

export async function checkUserActivity(
  repoPath: string,
  provider: ProviderId,
  config: WetGlobalConfig,
  hoursUntilExpiry?: number | null
): Promise<ActivityCheckResult> {
  // 1. Interactive CLI process check
  const interactiveCli = await hasInteractiveCliProcess(provider);
  if (interactiveCli) {
    return { active: true, reason: "Interactive AI CLI session detected" };
  }

  // 2. Recent AI log writes
  const recentAiLogs = hasRecentAiLogWrites(config.schedule.user_idle_minutes);
  if (recentAiLogs) {
    return { active: true, reason: "Recent human AI usage detected" };
  }

  // 3. Active editing on repository
  const recentRepoEdits = await hasRecentRepoEdits(repoPath, 10);
  if (recentRepoEdits) {
    return { active: true, reason: "Active human edits in repository" };
  }

  // 4. Quiet hours check
  const quietHoursConfig = config.schedule.quiet_hours;
  const inQuietHours = isInsideQuietHours(new Date(), quietHoursConfig, hoursUntilExpiry);
  if (!inQuietHours) {
    return { active: true, reason: "Outside quiet hours window" };
  }

  return { active: false };
}
