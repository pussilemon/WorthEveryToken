import { z } from "zod";

// Provider IDs
export const ProviderIdSchema = z.enum(["claude", "codex", "agy", "gemini", "custom"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const CustomProviderConfigSchema = z.object({
  binary: z.string(),
  audit_args: z.array(z.string()),
  exec_args: z.array(z.string()),
  usage_cmd: z.string().optional(),
  use_pty: z.boolean().default(false)
});
export type CustomProviderConfig = z.infer<typeof CustomProviderConfigSchema>;

export const QuotaBucketSchema = z.object({
  id: z.string(),
  role: z.enum(["primary", "sub_window"]),
  scope: z.enum(["account", "model"]),
  model: z.string().nullable().default(null),
  windowType: z.enum(["rolling", "fixed"]),
  durationHours: z.number().positive(),
  usedPct: z.number().min(0).max(100),
  resetAt: z.string().datetime().nullable(),
  confidence: z.enum(["high", "medium", "low"]).default("medium")
});
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const QuotaTopologyTypeSchema = z.enum([
  "TWO_TIER_WINDOW",
  "SINGLE_CYCLE_CAP",
  "ROLLING_ONLY",
  "MULTI_BUCKET_CASCADE",
  "UNKNOWN"
]);
export type QuotaTopologyType = z.infer<typeof QuotaTopologyTypeSchema>;

export const UsageSnapshotSchema = z.object({
  provider: ProviderIdSchema,
  probedAt: z.string().datetime(),
  source: z.enum([
    "cli_probe",
    "rate_limit_learned",
    "rate_limit_header",
    "local_logs",
    "benchmark_preset",
    "fallback_manual"
  ]),
  buckets: z.array(QuotaBucketSchema).default([]),
  detectedModel: z.string().nullable().default(null),
  rawSnippet: z.string().optional()
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const GlobalScheduleConfigSchema = z.object({
  auto_detect_reset: z.boolean().default(true),
  fallback_weekly_reset_day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).default("mon"),
  fallback_weekly_reset_time: z.string().default("08:00"),
  timezone: z.string().default("local"),
  window_hours: z.number().default(5),
  target_weekly_burn_pct: z.number().min(1).max(100).default(99),
  wave_buffer_minutes: z.number().min(0).default(15),
  hard_stop_before_reset_minutes: z.number().min(1).default(20),
  min_task_reserve_minutes: z.number().min(1).default(6),
  user_idle_minutes: z.number().min(1).default(15),
  quiet_hours: z
    .object({
      enabled: z.boolean().default(true),
      start: z.string().default("22:00"),
      end: z.string().default("08:00"),
      allow_daytime_if_expiring_within_hours: z.number().default(6)
    })
    .default(() => ({
      enabled: true,
      start: "22:00",
      end: "08:00",
      allow_daytime_if_expiring_within_hours: 6
    })),
  watcher_interval_minutes: z.number().min(1).default(15)
});

export const GlobalExecutionConfigSchema = z.object({
  max_parallel_workers: z.number().int().min(1).default(1),
  max_tasks_per_audit: z.number().int().min(1).default(25),
  max_audit_passes_per_cycle: z.number().int().min(1).default(3),
  max_retries_per_task: z.number().int().min(0).default(3),
  max_consecutive_failures: z.number().int().min(1).default(3),
  task_timeout_sec: z.number().int().min(10).default(300),
  silence_watchdog_sec: z.number().int().min(5).default(90)
});

export const GlobalCalibrationConfigSchema = z.object({
  sync_external_benchmarks: z.boolean().default(true),
  benchmark_source_url: z.string().default("https://aicodingdaily.com/subscription-usage"),
  benchmark_cache_ttl_hours: z.number().default(168),
  ema_alpha: z.number().min(0.01).max(1).default(0.4)
});

export const GlobalConfigSchema = z.object({
  provider: ProviderIdSchema.default("claude"),
  subscription_tier: z.string().default("auto"),
  model_override: z.string().default("auto"),
  reasoning_effort: z.enum(["max", "high", "medium"]).default("max"),
  custom_provider: CustomProviderConfigSchema.optional(),
  schedule: GlobalScheduleConfigSchema.default(() => GlobalScheduleConfigSchema.parse({})),
  execution: GlobalExecutionConfigSchema.default(() => GlobalExecutionConfigSchema.parse({})),
  calibration: GlobalCalibrationConfigSchema.default(() => GlobalCalibrationConfigSchema.parse({}))
});
export type WetGlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const ActiveProjectSchema = z.object({
  repoPath: z.string(),
  repoName: z.string(),
  armedAt: z.string().datetime(),
  auditBranch: z.string().nullable().default(null),
  status: z.enum(["armed", "running_wave", "waiting_window_reset", "completed_cycle", "paused", "yielded_to_user"]),
  auditPassCount: z.number().int().min(0).default(0),
  nextWakeAt: z.string().datetime().nullable().default(null),
  lastWaveStartedAt: z.string().datetime().nullable().default(null),
  lastWaveWeeklyPctBefore: z.number().min(0).max(100).nullable().default(null),
  lockedCycleResetAt: z.string().datetime().nullable().default(null),
  cyclePeakUsedPct: z.number().min(0).max(100).nullable().default(null),
  lastRunError: z.string().nullable().default(null)
});

export const LastKnownUsageSchema = z.object({
  provider: ProviderIdSchema,
  probedAt: z.string().datetime(),
  source: z.enum(["cli_probe", "rate_limit_learned", "rate_limit_header", "local_logs", "benchmark_preset", "fallback_manual"]),
  buckets: z.array(QuotaBucketSchema).default([]),
  weeklyUsedPct: z.number().min(0).max(100).nullable().optional(),
  weeklyResetAt: z.string().datetime().nullable().optional(),
  window5hUsedPct: z.number().min(0).max(100).nullable().optional(),
  window5hResetAt: z.string().datetime().nullable().optional(),
  detectedModel: z.string().nullable().optional()
});

export const MachineStateSchema = z.object({
  activeProject: ActiveProjectSchema.nullable().default(null),
  activeRunPid: z.number().int().nullable().default(null),
  lastKnownUsage: LastKnownUsageSchema.nullable().default(null)
});

export type ActiveProject = z.infer<typeof ActiveProjectSchema>;
export type LastKnownUsage = z.infer<typeof LastKnownUsageSchema>;
export type MachineState = z.infer<typeof MachineStateSchema>;

// Task & Backlog Schemas
export const TaskCategorySchema = z.enum([
  "bug",
  "race_condition",
  "memory_leak",
  "security",
  "edge_case",
  "test_coverage",
  "tech_debt",
  "typing_lint"
]);

export const TaskSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const AgentTypeSchema = z.enum(["claude", "codex", "agy", "gemini", "custom"]);
export const TaskComplexitySchema = z.enum(["small", "medium"]);
export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "skipped"]);

export const TaskDigestSchema = z.object({
  files_changed: z.array(z.string()),
  summary: z.string(),
  tests_added: z.number().int().min(0),
  risks: z.array(z.string())
});

export const TaskMetricsSchema = z.object({
  agent_used: z.string().optional(),
  provider: ProviderIdSchema.optional(),
  fallback_triggered: z.boolean().default(false),
  duration_ms: z.number().optional(),
  estimated_cost_usd: z.number().optional()
});

export const TaskSchema = z.object({
  id: z.string().regex(/^T-\d{3}$/),
  title: z.string().min(5).max(120),
  category: TaskCategorySchema,
  severity: TaskSeveritySchema,
  assigned_agent: AgentTypeSchema.optional().default("claude"),
  target_files: z.array(z.string()).min(1).max(6),
  depends_on: z.array(z.string()).default([]),
  description: z.string().min(20),
  acceptance_criteria: z.array(z.string()).min(1),
  estimated_complexity: TaskComplexitySchema,
  status: TaskStatusSchema.default("pending"),
  retries: z.number().int().min(0).default(0),
  commit_sha: z.string().nullable().default(null),
  failure_reason: z.string().nullable().default(null),
  digest: TaskDigestSchema.nullable().default(null),
  metrics: TaskMetricsSchema.optional()
});

export const BacklogSchema = z.object({
  generated_at: z.string().datetime(),
  base_branch: z.string(),
  audit_branch: z.string(),
  tasks: z.array(TaskSchema)
});

export const QualityGateCommandSchema = z.object({
  name: z.string(),
  cmd: z.string()
});

export const ProjectConfigSchema = z.object({
  root: z.string().default("."),
  base_branch: z.string().default("main"),
  audit_branch_prefix: z.string().default("ai-weekend-audit"),
  worktree_dir: z.string().default(".wet/worktrees"),
  max_parallel_workers: z.number().int().min(1).default(2)
});

export const LimitsConfigSchema = z.object({
  max_total_tasks: z.number().int().min(1).default(25),
  max_retries_per_task: z.number().int().min(0).default(3),
  max_consecutive_failures: z.number().int().min(1).default(3),
  claude_max_turns_per_task: z.number().int().min(1).default(18),
  claude_max_budget_usd_per_task: z.number().min(0).default(2.5),
  claude_max_session_budget_usd: z.number().min(0).default(25.0),
  stop_at_five_hour_quota_pct: z.number().min(1).max(100).default(90),
  stop_at_weekly_quota_pct: z.number().min(1).max(100).default(95),
  agy_wall_clock_timeout_sec: z.number().int().min(10).default(180),
  agy_silence_watchdog_sec: z.number().int().min(5).default(60)
});

export const RoutingConfigSchema = z.object({
  claude_categories: z.array(TaskCategorySchema).default(["bug", "race_condition", "memory_leak", "security", "edge_case"]),
  agy_categories: z.array(TaskCategorySchema).default(["test_coverage", "tech_debt", "typing_lint"]),
  agy_fallback_to_claude: z.boolean().default(true)
});

export const QualityGatesConfigSchema = z.object({
  auto_detect: z.boolean().default(true),
  commands: z.array(QualityGateCommandSchema).default([
    { name: "typecheck", cmd: "npm run typecheck" },
    { name: "lint", cmd: "npm run lint" },
    { name: "test", cmd: "npm test" }
  ]),
  gate_timeout_sec: z.number().int().min(5).default(120)
});

export const AgyConfigSchema = z.object({
  binary: z.string().default("agy"),
  use_pty: z.boolean().default(true),
  disable_slow_mcp: z.boolean().default(true),
  extra_args: z.array(z.string()).default(["--output-format", "json"])
});

export const ClaudeConfigSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().default("sonnet"),
  audit_model: z.string().default("opus")
});

export const ConfigSchema = z.object({
  project: ProjectConfigSchema.default(() => ProjectConfigSchema.parse({})),
  limits: LimitsConfigSchema.default(() => LimitsConfigSchema.parse({})),
  routing: RoutingConfigSchema.default(() => RoutingConfigSchema.parse({})),
  quality_gates: QualityGatesConfigSchema.default(() => QualityGatesConfigSchema.parse({})),
  agy: AgyConfigSchema.default(() => AgyConfigSchema.parse({})),
  claude: ClaudeConfigSchema.default(() => ClaudeConfigSchema.parse({}))
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskDigest = z.infer<typeof TaskDigestSchema>;
export type Backlog = z.infer<typeof BacklogSchema>;
export type WetConfig = z.infer<typeof ConfigSchema>;
export type QualityGateCommand = z.infer<typeof QualityGateCommandSchema>;
export type TaskCategory = z.infer<typeof TaskCategorySchema>;
export type TaskSeverity = z.infer<typeof TaskSeveritySchema>;
export type AgentType = z.infer<typeof AgentTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
