import {
  type QuotaBucket,
  type QuotaTopologyType,
  QuotaBucketSchema,
  QuotaTopologyTypeSchema
} from "../config/schema.js";

export { QuotaBucketSchema, QuotaTopologyTypeSchema };

export interface QuotaTopology {
  type: QuotaTopologyType;
  primaryBucket: QuotaBucket | null;
  subWindowBucket: QuotaBucket | null;
  modelBuckets: QuotaBucket[];
  buckets: QuotaBucket[];
}

// Known model quality ranking (higher index = higher quality)
const MODEL_QUALITY_ORDER: Record<string, number> = {
  opus: 100,
  "claude-3-7-opus": 100,
  "claude-3-opus": 95,
  sonnet: 80,
  "claude-3-5-sonnet": 80,
  haiku: 60,
  "o3-mini": 90,
  o3: 95,
  o1: 90,
  "gpt-4o": 80,
  "gemini-2.5-pro": 90,
  "gemini-2.5-flash": 70
};

export function classifyTopology(buckets: QuotaBucket[]): QuotaTopology {
  if (!buckets || buckets.length === 0) {
    return {
      type: "UNKNOWN",
      primaryBucket: null,
      subWindowBucket: null,
      modelBuckets: [],
      buckets: []
    };
  }

  // 1. Check for MULTI_BUCKET_CASCADE: 2 or more buckets with scope === "model" and distinct models
  const modelBuckets = buckets.filter((b) => b.scope === "model" && b.model !== null);
  const distinctModels = new Set(modelBuckets.map((b) => b.model!.toLowerCase()));

  if (distinctModels.size >= 2) {
    // Sort model buckets by quality priority (highest to lowest)
    const sortedModelBuckets = [...modelBuckets].sort((a, b) => {
      const qA = MODEL_QUALITY_ORDER[a.model!.toLowerCase()] ?? 50;
      const qB = MODEL_QUALITY_ORDER[b.model!.toLowerCase()] ?? 50;
      return qB - qA;
    });

    const primary = sortedModelBuckets.find((b) => b.role === "primary") ?? sortedModelBuckets[0] ?? null;
    const sub = sortedModelBuckets.find((b) => b.role === "sub_window") ?? null;

    return {
      type: "MULTI_BUCKET_CASCADE",
      primaryBucket: primary,
      subWindowBucket: sub,
      modelBuckets: sortedModelBuckets,
      buckets
    };
  }

  // 2. Check for TWO_TIER_WINDOW: at least one primary and one sub_window
  const primaryBucket = buckets.find((b) => b.role === "primary") ?? null;
  const subWindowBucket = buckets.find((b) => b.role === "sub_window") ?? null;

  if (primaryBucket && subWindowBucket) {
    return {
      type: "TWO_TIER_WINDOW",
      primaryBucket,
      subWindowBucket,
      modelBuckets,
      buckets
    };
  }

  // 3. Single bucket checks
  if (buckets.length === 1) {
    const single = buckets[0]!;
    if (single.durationHours >= 24) {
      return {
        type: "SINGLE_CYCLE_CAP",
        primaryBucket: single,
        subWindowBucket: null,
        modelBuckets,
        buckets
      };
    } else {
      return {
        type: "ROLLING_ONLY",
        primaryBucket: null,
        subWindowBucket: single,
        modelBuckets,
        buckets
      };
    }
  }

  // 4. Fallback for multiple buckets with only primary (e.g. daily + weekly without sub-window)
  if (primaryBucket && !subWindowBucket) {
    return {
      type: "SINGLE_CYCLE_CAP",
      primaryBucket,
      subWindowBucket: null,
      modelBuckets,
      buckets
    };
  }

  // 5. Fallback for multiple buckets with only sub_window
  if (!primaryBucket && subWindowBucket) {
    return {
      type: "ROLLING_ONLY",
      primaryBucket: null,
      subWindowBucket,
      modelBuckets,
      buckets
    };
  }

  return {
    type: "UNKNOWN",
    primaryBucket: null,
    subWindowBucket: null,
    modelBuckets,
    buckets
  };
}

export function getPrimaryRemainingPct(topology: QuotaTopology, targetBurn = 99): number {
  if (topology.primaryBucket) {
    return Math.max(0, targetBurn - topology.primaryBucket.usedPct);
  }
  if (topology.subWindowBucket) {
    return Math.max(0, targetBurn - topology.subWindowBucket.usedPct);
  }
  return 0;
}
