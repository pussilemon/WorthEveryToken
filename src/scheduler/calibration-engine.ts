import fs from "node:fs";
import path from "node:path";
import type { ProviderId } from "../config/schema.js";
import { getGlobalWetDir } from "../config/global-store.js";
import { logger } from "../utils/logger.js";

export interface CalibrationEntry {
  weeklyPctPer5hWave: number;
  primaryPctPerSubWindow?: number;
  primaryPctPerHour?: number;
  avgActiveMinutesPerWave?: number;
  source: "observed" | "benchmark" | "preset";
  samples: number;
  lastUpdated: string;
}

export type RateLimitClassification =
  | { type: "TRANSIENT_THROTTLE"; backoffSec: number; reason: string }
  | { type: "SUB_WINDOW_EXHAUSTED"; subWindowDurationHours: number; resetAt: Date | null; reason: string }
  | { type: "PRIMARY_QUOTA_EXHAUSTED"; primaryResetAt: Date | null; reason: string };

export function classifyRateLimitError(
  errorText: string,
  resetAt: Date | null,
  now: Date = new Date()
): RateLimitClassification {
  const lower = errorText.toLowerCase();

  let waitMinutes: number | null = null;
  if (resetAt) {
    waitMinutes = Math.max(0, (resetAt.getTime() - now.getTime()) / 60_000);
  }

  const secWaitMatch = lower.match(/(?:retry|wait|try again)?\s*in\s*(\d+)\s*(?:s|sec|seconds?)/i);
  if (secWaitMatch?.[1]) {
    waitMinutes = parseInt(secWaitMatch[1], 10) / 60;
  }
  const minWaitMatch = lower.match(/(?:retry|wait|try again)?\s*in\s*(\d+)\s*(?:m|min|minutes?)/i);
  if (minWaitMatch?.[1]) {
    waitMinutes = parseInt(minWaitMatch[1], 10);
  }
  const hourWaitMatch = lower.match(/(?:retry|wait|try again)?\s*in\s*(\d+)\s*(?:h|hours?)/i);
  if (hourWaitMatch?.[1]) {
    waitMinutes = parseInt(hourWaitMatch[1], 10) * 60;
  }

  // 1. Transient throttle: wait < 5 minutes or mentions RPM / TPM / overloaded
  if (
    (waitMinutes !== null && waitMinutes < 5) ||
    lower.includes("rpm") ||
    lower.includes("tpm") ||
    lower.includes("overloaded") ||
    (lower.includes("rate_limit_error") && (waitMinutes === null || waitMinutes < 5))
  ) {
    const backoffSec = waitMinutes !== null && waitMinutes > 0 ? Math.ceil(waitMinutes * 60) : 30;
    return {
      type: "TRANSIENT_THROTTLE",
      backoffSec: Math.min(90, Math.max(30, backoffSec)),
      reason: "Transient rate limit throttle / concurrency overload"
    };
  }

  // 2. Primary quota exhausted: wait > 12 hours or explicit daily / weekly / monthly
  if (
    (waitMinutes !== null && waitMinutes > 12 * 60) ||
    lower.includes("weekly") ||
    lower.includes("daily limit") ||
    lower.includes("monthly quota") ||
    lower.includes("weekly limit")
  ) {
    return {
      type: "PRIMARY_QUOTA_EXHAUSTED",
      primaryResetAt: resetAt,
      reason: "Primary cycle quota exhausted"
    };
  }

  // 3. Sub-window exhausted: wait between 15 minutes and 12 hours (or mentions 5-hour / 3-hour / session)
  if (
    (waitMinutes !== null && waitMinutes >= 15 && waitMinutes <= 12 * 60) ||
    lower.includes("5-hour") ||
    lower.includes("3-hour") ||
    lower.includes("session limit")
  ) {
    let subDuration = 5;
    if (lower.includes("3-hour") || lower.includes("3h")) subDuration = 3;
    if (lower.includes("6-hour") || lower.includes("6h")) subDuration = 6;
    if (waitMinutes !== null && waitMinutes > 0) {
      subDuration = Math.round(waitMinutes / 60) || subDuration;
    }

    return {
      type: "SUB_WINDOW_EXHAUSTED",
      subWindowDurationHours: subDuration,
      resetAt,
      reason: `Sub-window capacity exhausted (${subDuration}h)`
    };
  }

  // Default fallback if unclassified
  return {
    type: "SUB_WINDOW_EXHAUSTED",
    subWindowDurationHours: 5,
    resetAt,
    reason: "Unclassified rate limit treated as sub-window pause"
  };
}

export interface CalibrationData {
  rates: Record<string, CalibrationEntry>;
}

export interface BenchmarkCache {
  fetchedAt: string;
  rates: Record<string, number>;
}

export const BUILTIN_PRESETS: Record<string, number> = {
  "claude-pro-20": 9,
  "claude-max-100": 12,
  "codex-plus-20": 10,
  "agy-pro": 12,
  "gemini": 14,
  "claude": 9,
  "codex": 10,
  "agy": 12,
  "custom": 10,
  "default": 10
};

export class CalibrationEngine {
  private readonly calibrationPath: string;
  private readonly cachePath: string;

  constructor(customWetDir?: string) {
    const dir = customWetDir ?? getGlobalWetDir();
    this.calibrationPath = path.join(dir, "calibration.json");
    this.cachePath = path.join(dir, "benchmarks-cache.json");
  }

  public loadCalibration(): CalibrationData {
    if (!fs.existsSync(this.calibrationPath)) {
      return { rates: {} };
    }
    try {
      const raw = fs.readFileSync(this.calibrationPath, "utf-8");
      return JSON.parse(raw) as CalibrationData;
    } catch (err) {
      logger.debug({ err }, "Could not read calibration.json, using defaults");
      return { rates: {} };
    }
  }

  public saveCalibration(data: CalibrationData): void {
    try {
      const dir = path.dirname(this.calibrationPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.calibrationPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      logger.warn({ err }, "Failed to write calibration.json");
    }
  }

  public loadBenchmarkCache(): BenchmarkCache | null {
    if (!fs.existsSync(this.cachePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.cachePath, "utf-8");
      return JSON.parse(raw) as BenchmarkCache;
    } catch {
      return null;
    }
  }

  public saveBenchmarkCache(cache: BenchmarkCache): void {
    try {
      const dir = path.dirname(this.cachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), "utf-8");
    } catch (err) {
      logger.debug({ err }, "Failed to write benchmarks-cache.json");
    }
  }

  public async syncExternalBenchmarks(
    url = "https://aicodingdaily.com/subscription-usage",
    ttlHours = 168
  ): Promise<void> {
    const cached = this.loadBenchmarkCache();
    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
      if (ageMs < ttlHours * 3600_000) {
        logger.debug("Benchmark cache still fresh, skipping fetch");
        return;
      }
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "WorthEveryToken/2.0" }
      });

      if (!res.ok) {
        logger.debug({ status: res.status }, "Benchmark fetch non-ok response, using fallback");
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      let rates: Record<string, number> = {};

      if (contentType.includes("application/json")) {
        const json = (await res.json()) as any;
        if (json && typeof json.rates === "object") {
          rates = json.rates;
        }
      } else {
        const html = await res.text();
        // Defensive regex extraction if structured table or json snippet present
        const jsonMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (jsonMatch?.[1]) {
          try {
            const data = JSON.parse(jsonMatch[1]);
            if (data?.props?.pageProps?.rates) {
              rates = data.props.pageProps.rates;
            }
          } catch {
            // Ignore
          }
        }
      }

      if (Object.keys(rates).length > 0) {
        this.saveBenchmarkCache({
          fetchedAt: new Date().toISOString(),
          rates
        });
        logger.info({ rateKeys: Object.keys(rates) }, "Synced subscription benchmarks cache");
      }
    } catch (err) {
      logger.debug({ err }, "External benchmark sync failed gracefully (using presets/observed)");
    }
  }

  public getRateForProvider(
    provider: ProviderId,
    tier = "auto"
  ): { rate: number; source: "observed" | "benchmark" | "preset" } {
    // 1. Observed field data has top priority
    const calib = this.loadCalibration();
    const observed = calib.rates[provider];
    if (observed && observed.source === "observed") {
      return { rate: observed.weeklyPctPer5hWave, source: "observed" };
    }

    // 2. Benchmark cache
    const cache = this.loadBenchmarkCache();
    if (cache?.rates) {
      const key = tier !== "auto" && cache.rates[tier] ? tier : cache.rates[provider] ? provider : null;
      if (key && typeof cache.rates[key] === "number") {
        return { rate: cache.rates[key]!, source: "benchmark" };
      }
    }

    // 3. Built-in Presets
    if (tier !== "auto" && BUILTIN_PRESETS[tier]) {
      return { rate: BUILTIN_PRESETS[tier]!, source: "preset" };
    }
    if (BUILTIN_PRESETS[provider]) {
      return { rate: BUILTIN_PRESETS[provider]!, source: "preset" };
    }
    return { rate: BUILTIN_PRESETS["default"]!, source: "preset" };
  }

  public recordObservedWave(params: {
    provider: ProviderId;
    weeklyPctBefore: number;
    weeklyPctAfter: number;
    emaAlpha?: number;
  }): number | null {
    const { provider, weeklyPctBefore, weeklyPctAfter } = params;
    const alpha = params.emaAlpha ?? 0.4;
    const delta = weeklyPctAfter - weeklyPctBefore;

    // Discard anomalous or unmeasurable deltas (<= 0.5% or > 60%)
    if (delta <= 0.5 || delta > 60) {
      logger.warn(
        { delta, weeklyPctBefore, weeklyPctAfter },
        "Observed delta out of sane calibration bounds (<=0.5% or >60%), ignoring."
      );
      return null;
    }

    const calib = this.loadCalibration();
    const existing = calib.rates[provider];

    let newRate = delta;
    let samples = 1;

    if (existing && existing.source === "observed") {
      newRate = Number((alpha * delta + (1 - alpha) * existing.weeklyPctPer5hWave).toFixed(2));
      samples = existing.samples + 1;
    } else {
      newRate = Number(delta.toFixed(2));
    }

    calib.rates[provider] = {
      weeklyPctPer5hWave: newRate,
      source: "observed",
      samples,
      lastUpdated: new Date().toISOString()
    };

    this.saveCalibration(calib);
    logger.info(
      { provider, delta, newRate, samples },
      "Updated EMA rate calibration for provider"
    );

    return newRate;
  }
}
