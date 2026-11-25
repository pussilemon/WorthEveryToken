import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { QuotaGuard } from "../src/telemetry/quota-guard.js";

describe("QuotaGuard", () => {
  let tmpDir: string;
  let stateFile: string;
  let claudeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wet-quota-test-"));
    stateFile = path.join(tmpDir, "quota-state.json");
    claudeDir = path.join(tmpDir, "projects", "my-project");
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should parse entry.message.usage including cache tokens and calculate costs", () => {
    const logFile = path.join(claudeDir, "session.jsonl");

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      message: {
        usage: {
          input_tokens: 100000,
          output_tokens: 20000,
          cache_creation_input_tokens: 10000,
          cache_read_input_tokens: 50000
        }
      }
    }) + "\n";

    fs.writeFileSync(logFile, line, "utf-8");

    const quotaGuard = new QuotaGuard(
      {
        claudeMaxSessionBudgetUsd: 10.0,
        stopAtFiveHourQuotaPct: 90,
        stopAtWeeklyQuotaPct: 95
      },
      stateFile,
      tmpDir
    );

    const usage = quotaGuard.scanLogs();
    expect(usage.tokens5h).toBe(180000);
    expect(usage.cost5hUsd).toBeGreaterThan(0);
  });

  it("should correctly handle 5-hour sliding window decay vs 7-day window", () => {
    const logFile = path.join(claudeDir, "history.jsonl");
    const now = Date.now();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000).toISOString();

    // Event 1: 6 hours ago
    const line1 = JSON.stringify({
      timestamp: sixHoursAgo,
      usage: { input_tokens: 100000, output_tokens: 10000 }
    }) + "\n";

    // Event 2: 1 hour ago
    const line2 = JSON.stringify({
      timestamp: oneHourAgo,
      usage: { input_tokens: 50000, output_tokens: 5000 }
    }) + "\n";

    fs.writeFileSync(logFile, line1 + line2, "utf-8");

    const quotaGuard = new QuotaGuard(
      {
        claudeMaxSessionBudgetUsd: 25.0,
        stopAtFiveHourQuotaPct: 90,
        stopAtWeeklyQuotaPct: 95
      },
      stateFile,
      tmpDir
    );

    const usage = quotaGuard.scanLogs(now);

    // 5-hour window should only count Event 2 (55,000 tokens)
    expect(usage.tokens5h).toBe(55000);

    // 7-day window should count both Event 1 and Event 2 (110,000 + 55,000 = 165,000 tokens)
    expect(usage.tokens7d).toBe(165000);
    expect(usage.cost7dUsd).toBeGreaterThan(usage.cost5hUsd);
  });

  it("should trigger shouldStop when session cost exceeds budget limit", () => {
    const quotaGuard = new QuotaGuard(
      {
        claudeMaxSessionBudgetUsd: 5.0,
        stopAtFiveHourQuotaPct: 90,
        stopAtWeeklyQuotaPct: 95
      },
      stateFile,
      tmpDir
    );

    expect(quotaGuard.shouldStop().stop).toBe(false);

    // Add cost pushing past budget limit
    quotaGuard.addSessionCost(5.50);

    const check = quotaGuard.shouldStop();
    expect(check.stop).toBe(true);
    expect(check.reason).toContain("reached max budget");
  });
});
