import { z } from "zod";

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
export const AgentTypeSchema = z.enum(["claude", "agy"]);
export const TaskComplexitySchema = z.enum(["small", "medium"]);
export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "skipped"]);

export const TaskDigestSchema = z.object({
  files_changed: z.array(z.string()),
  summary: z.string(),
  tests_added: z.number().int().min(0),
  risks: z.array(z.string())
});

export const TaskMetricsSchema = z.object({
  agent_used: z.enum(["claude", "agy"]).optional(),
  fallback_triggered: z.boolean().default(false),
  duration_ms: z.number().optional(),
  estimated_cost_usd: z.number().optional()
});

export const TaskSchema = z.object({
  id: z.string().regex(/^T-\d{3}$/),
  title: z.string().min(5).max(120),
  category: TaskCategorySchema,
  severity: TaskSeveritySchema,
  assigned_agent: AgentTypeSchema,
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

export const ConfigSchema = z.object({
  project: z.object({
    root: z.string().default("."),
    base_branch: z.string().default("main"),
    audit_branch_prefix: z.string().default("ai-weekend-audit"),
    worktree_dir: z.string().default(".wqb/worktrees"),
    max_parallel_workers: z.number().int().min(1).default(2)
  }),
  limits: z.object({
    max_total_tasks: z.number().int().min(1).default(25),
    max_retries_per_task: z.number().int().min(0).default(3),
    max_consecutive_failures: z.number().int().min(1).default(3),
    claude_max_turns_per_task: z.number().int().min(1).default(18),
    claude_max_budget_usd_per_task: z.number().min(0).default(2.50),
    claude_max_session_budget_usd: z.number().min(0).default(25.00),
    stop_at_five_hour_quota_pct: z.number().min(1).max(100).default(90),
    stop_at_weekly_quota_pct: z.number().min(1).max(100).default(95),
    agy_wall_clock_timeout_sec: z.number().int().min(10).default(180),
    agy_silence_watchdog_sec: z.number().int().min(5).default(60)
  }),
  routing: z.object({
    claude_categories: z.array(TaskCategorySchema).default(["bug", "race_condition", "memory_leak", "security", "edge_case"]),
    agy_categories: z.array(TaskCategorySchema).default(["test_coverage", "tech_debt", "typing_lint"]),
    agy_fallback_to_claude: z.boolean().default(true)
  }),
  quality_gates: z.object({
    auto_detect: z.boolean().default(true),
    commands: z.array(QualityGateCommandSchema).default([
      { name: "typecheck", cmd: "npm run typecheck" },
      { name: "lint", cmd: "npm run lint" },
      { name: "test", cmd: "npm test" }
    ]),
    gate_timeout_sec: z.number().int().min(5).default(120)
  }),
  agy: z.object({
    binary: z.string().default("agy"),
    use_pty: z.boolean().default(true),
    disable_slow_mcp: z.boolean().default(true),
    extra_args: z.array(z.string()).default(["--output-format", "json"])
  }),
  claude: z.object({
    binary: z.string().default("claude"),
    model: z.string().default("sonnet"),
    audit_model: z.string().default("opus")
  })
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskDigest = z.infer<typeof TaskDigestSchema>;
export type Backlog = z.infer<typeof BacklogSchema>;
export type WqbConfig = z.infer<typeof ConfigSchema>;
export type QualityGateCommand = z.infer<typeof QualityGateCommandSchema>;
export type TaskCategory = z.infer<typeof TaskCategorySchema>;
export type TaskSeverity = z.infer<typeof TaskSeveritySchema>;
export type AgentType = z.infer<typeof AgentTypeSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
