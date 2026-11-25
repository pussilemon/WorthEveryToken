import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  isInsideQuietHours,
  hasRecentRepoEdits,
  checkUserActivity
} from "../src/scheduler/activity-guard.js";
import type { WetGlobalConfig } from "../src/config/schema.js";

describe("UserActivityGuard (Invisible Mode & Auto-Yield)", () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "wet-activity-guard-"));
    await execa("git", ["init"], { cwd: tmpRepo });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    await execa("git", ["config", "user.email", "test@user.com"], { cwd: tmpRepo });

    // Initial commit
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Test Repo\n", "utf-8");
    await execa("git", ["add", "."], { cwd: tmpRepo });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: tmpRepo });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRepo)) {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  describe("isInsideQuietHours", () => {
    it("should return true when quiet hours are disabled", () => {
      const now = new Date("2026-11-25T14:00:00Z"); // Wednesday 14:00
      const quiet = {
        enabled: false,
        start: "22:00",
        end: "08:00",
        allow_daytime_if_expiring_within_hours: 6
      };
      expect(isInsideQuietHours(now, quiet)).toBe(true);
    });

    it("should return true on weekends regardless of hour", () => {
      // 2026-11-28 is Saturday
      const saturdayNoon = new Date("2026-11-28T12:00:00Z");
      const quiet = {
        enabled: true,
        start: "22:00",
        end: "08:00",
        allow_daytime_if_expiring_within_hours: 6
      };
      expect(isInsideQuietHours(saturdayNoon, quiet)).toBe(true);

      // 2026-11-29 is Sunday
      const sundayNoon = new Date("2026-11-29T15:00:00Z");
      expect(isInsideQuietHours(sundayNoon, quiet)).toBe(true);
    });

    it("should return true during nighttime window across midnight", () => {
      // Wednesday at 23:30 (local time)
      const lateNight = new Date(2026, 10, 25, 23, 30, 0); // Month is 0-indexed: 10 = Nov
      const quiet = {
        enabled: true,
        start: "22:00",
        end: "08:00",
        allow_daytime_if_expiring_within_hours: 6
      };
      expect(isInsideQuietHours(lateNight, quiet)).toBe(true);

      // Early morning at 05:00
      const earlyMorning = new Date(2026, 10, 25, 5, 0, 0);
      expect(isInsideQuietHours(earlyMorning, quiet)).toBe(true);
    });

    it("should return false during daytime on a weekday", () => {
      // Wednesday at 14:00 (local time)
      const daytime = new Date(2026, 10, 25, 14, 0, 0);
      const quiet = {
        enabled: true,
        start: "22:00",
        end: "08:00",
        allow_daytime_if_expiring_within_hours: 6
      };
      expect(isInsideQuietHours(daytime, quiet)).toBe(false);
    });

    it("should return true during daytime if expiring within allow_daytime_if_expiring_within_hours", () => {
      const daytime = new Date(2026, 10, 25, 14, 0, 0);
      const quiet = {
        enabled: true,
        start: "22:00",
        end: "08:00",
        allow_daytime_if_expiring_within_hours: 6
      };
      // Quota expires in 4 hours (< 6h limit)
      expect(isInsideQuietHours(daytime, quiet, 4)).toBe(true);
      // Quota expires in 12 hours (> 6h limit)
      expect(isInsideQuietHours(daytime, quiet, 12)).toBe(false);
    });
  });

  describe("hasRecentRepoEdits", () => {
    it("should return false when repo is clean and idle", async () => {
      // Fake old mtime
      const oldTime = new Date(Date.now() - 3600_000); // 1 hour ago
      fs.utimesSync(path.join(tmpRepo, "README.md"), oldTime, oldTime);

      const hasEdits = await hasRecentRepoEdits(tmpRepo, 10);
      expect(hasEdits).toBe(false);
    });

    it("should return false when dirty uncommitted files are older than recentEditMinutes", async () => {
      const dirtyFilePath = path.join(tmpRepo, "old_wip.ts");
      fs.writeFileSync(dirtyFilePath, "const old = true;", "utf-8");

      // Backdate mtime by 2 hours (120 minutes > 10 minute threshold)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(dirtyFilePath, twoHoursAgo, twoHoursAgo);

      // Backdate committed files too
      fs.utimesSync(path.join(tmpRepo, "README.md"), twoHoursAgo, twoHoursAgo);

      const hasEdits = await hasRecentRepoEdits(tmpRepo, 10);
      expect(hasEdits).toBe(false);
    });

    it("should return true when a dirty uncommitted file was touched recently (30 seconds ago)", async () => {
      const dirtyFilePath = path.join(tmpRepo, "recent_wip.ts");
      fs.writeFileSync(dirtyFilePath, "const active = true;", "utf-8");

      // Mtime is 30 seconds ago (< 10 minutes)
      const thirtySecAgo = new Date(Date.now() - 30_000);
      fs.utimesSync(dirtyFilePath, thirtySecAgo, thirtySecAgo);

      const hasEdits = await hasRecentRepoEdits(tmpRepo, 10);
      expect(hasEdits).toBe(true);
    });

    it("should return true when committed files were touched recently", async () => {
      // Modify file and commit it, but mtime is now
      fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Updated Recently\n", "utf-8");
      await execa("git", ["commit", "-am", "user commit"], { cwd: tmpRepo });

      const hasEdits = await hasRecentRepoEdits(tmpRepo, 10);
      expect(hasEdits).toBe(true);
    });
  });

  describe("checkUserActivity", () => {
    it("should yield when active repo edits are detected", async () => {
      fs.writeFileSync(path.join(tmpRepo, "draft.txt"), "Human is typing here...", "utf-8");

      const config: WetGlobalConfig = {
        provider: "custom",
        subscription_tier: "auto",
        model_override: "auto",
        reasoning_effort: "max",
        schedule: {
          window_hours: 5,
          wave_buffer_minutes: 15,
          target_weekly_burn_pct: 99,
          hard_stop_before_reset_minutes: 20,
          min_task_reserve_minutes: 6,
          user_idle_minutes: 15,
          quiet_hours: {
            enabled: false, // Disabled to isolate repo check
            start: "22:00",
            end: "08:00",
            allow_daytime_if_expiring_within_hours: 6
          }
        },
        execution: {
          max_parallel_agents: 1,
          task_retry_limit: 1,
          stagnation_timeout_sec: 10,
          quality_gate_order: ["audit", "test", "lint", "typecheck"]
        },
        calibration: {
          ema_alpha: 0.4,
          max_weekly_pct_per_wave: 50
        }
      };

      const result = await checkUserActivity(tmpRepo, "custom", config);
      expect(result.active).toBe(true);
      expect(result.reason).toBe("Active human edits in repository");
    });

    it("should return active: false when system is idle and quiet hours satisfied", async () => {
      const oldTime = new Date(Date.now() - 3600_000);
      fs.utimesSync(path.join(tmpRepo, "README.md"), oldTime, oldTime);

      const config: WetGlobalConfig = {
        provider: "custom",
        subscription_tier: "auto",
        model_override: "auto",
        reasoning_effort: "max",
        schedule: {
          window_hours: 5,
          wave_buffer_minutes: 15,
          target_weekly_burn_pct: 99,
          hard_stop_before_reset_minutes: 20,
          min_task_reserve_minutes: 6,
          user_idle_minutes: 15,
          quiet_hours: {
            enabled: false,
            start: "22:00",
            end: "08:00",
            allow_daytime_if_expiring_within_hours: 6
          }
        },
        execution: {
          max_parallel_agents: 1,
          task_retry_limit: 1,
          stagnation_timeout_sec: 10,
          quality_gate_order: ["audit", "test", "lint", "typecheck"]
        },
        calibration: {
          ema_alpha: 0.4,
          max_weekly_pct_per_wave: 50
        }
      };

      const result = await checkUserActivity(tmpRepo, "custom", config);
      expect(result.active).toBe(false);
    });
  });
});
