import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CalibrationEngine } from "../src/scheduler/calibration-engine.js";

describe("CalibrationEngine", () => {
  let tmpDir: string;
  let engine: CalibrationEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wet-calib-test-"));
    engine = new CalibrationEngine(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("returns builtin presets when no observed or cached data exists", () => {
    const claudeRate = engine.getRateForProvider("claude", "claude-pro-20");
    expect(claudeRate.rate).toBe(9);
    expect(claudeRate.source).toBe("preset");

    const codexRate = engine.getRateForProvider("codex", "codex-plus-20");
    expect(codexRate.rate).toBe(10);
    expect(codexRate.source).toBe("preset");

    const geminiRate = engine.getRateForProvider("gemini");
    expect(geminiRate.rate).toBe(14);
    expect(geminiRate.source).toBe("preset");
  });

  it("records observed field wave and updates EMA calibration", () => {
    // Wave 1: 72% -> 82% (delta: 10%)
    const rate1 = engine.recordObservedWave({
      provider: "claude",
      weeklyPctBefore: 72,
      weeklyPctAfter: 82,
      emaAlpha: 0.4
    });
    expect(rate1).toBe(10);

    const lookup1 = engine.getRateForProvider("claude");
    expect(lookup1.rate).toBe(10);
    expect(lookup1.source).toBe("observed");

    // Wave 2: 82% -> 94% (delta: 12%)
    // New EMA rate = 0.4 * 12 + 0.6 * 10 = 4.8 + 6.0 = 10.8%
    const rate2 = engine.recordObservedWave({
      provider: "claude",
      weeklyPctBefore: 82,
      weeklyPctAfter: 94,
      emaAlpha: 0.4
    });
    expect(rate2).toBe(10.8);

    const lookup2 = engine.getRateForProvider("claude");
    expect(lookup2.rate).toBe(10.8);
    expect(lookup2.source).toBe("observed");
  });

  it("discards anomalous deltas (<= 0.5% or > 60%)", () => {
    // Anomaly: 0% delta
    const resultZero = engine.recordObservedWave({
      provider: "claude",
      weeklyPctBefore: 50,
      weeklyPctAfter: 50
    });
    expect(resultZero).toBeNull();

    // Anomaly: 70% delta
    const resultHuge = engine.recordObservedWave({
      provider: "claude",
      weeklyPctBefore: 10,
      weeklyPctAfter: 80
    });
    expect(resultHuge).toBeNull();

    // Rates should remain untouched (falls back to preset)
    const lookup = engine.getRateForProvider("claude");
    expect(lookup.source).toBe("preset");
  });

  it("gives observed field rate absolute priority over benchmark cache and presets", () => {
    // Put a benchmark in cache
    engine.saveBenchmarkCache({
      fetchedAt: new Date().toISOString(),
      rates: { claude: 15 }
    });

    const lookupBenchmark = engine.getRateForProvider("claude");
    expect(lookupBenchmark.rate).toBe(15);
    expect(lookupBenchmark.source).toBe("benchmark");

    // Record an observed wave
    engine.recordObservedWave({
      provider: "claude",
      weeklyPctBefore: 20,
      weeklyPctAfter: 28 // delta 8%
    });

    const lookupObserved = engine.getRateForProvider("claude");
    expect(lookupObserved.rate).toBe(8);
    expect(lookupObserved.source).toBe("observed");
  });
});
