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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wqb-quota-test-"));
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

  it("should incrementally scan jsonl files and track byte offsets", () => {
    const logFile = path.join(claudeDir, "session.jsonl");

    const line1 = JSON.stringify({
      timestamp: new Date().toISOString(),
      usage: { input_tokens: 100000, output_tokens: 20000 }
    }) + "\n";

    fs.writeFileSync(logFile, line1, "utf-8");

    const quotaGuard = new QuotaGuard(
      {
        claudeMaxSessionBudgetUsd: 10.0,
        stopAtFiveHourQuotaPct: 90,
        stopAtWeeklyQuotaPct: 95
      },
      stateFile,
      tmpDir
    );

    const usage1 = quotaGuard.scanLogs();
    expect(usage1.tokens5h).toBe(120000);
    expect(usage1.cost5hUsd).toBeGreaterThan(0);

    // Verify offset was persisted in state file
    const stateRaw = fs.readFileSync(stateFile, "utf-8");
    const state = JSON.parse(stateRaw);
    expect(state.fileOffsets[logFile]).toBe(Buffer.byteLength(line1));

    // Append second line
    const line2 = JSON.stringify({
      timestamp: new Date().toISOString(),
      usage: { input_tokens: 50000, output_tokens: 10000 }
    }) + "\n";
    fs.appendFileSync(logFile, line2, "utf-8");

    const usage2 = quotaGuard.scanLogs();
    // Tokens in this incremental read: previous 120000 + 60000 = 180000
    expect(usage2.tokens5h).toBe(180000);

    const stateRaw2 = fs.readFileSync(stateFile, "utf-8");
    const state2 = JSON.parse(stateRaw2);
    expect(state2.fileOffsets[logFile]).toBe(Buffer.byteLength(line1) + Buffer.byteLength(line2));
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
