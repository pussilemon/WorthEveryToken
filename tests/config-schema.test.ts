import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema.js";

describe("ConfigSchema", () => {
  it("should parse an empty object and populate all full defaults", () => {
    const config = ConfigSchema.parse({});

    expect(config.project.root).toBe(".");
    expect(config.project.base_branch).toBe("main");
    expect(config.project.audit_branch_prefix).toBe("ai-weekend-audit");
    expect(config.project.worktree_dir).toBe(".wet/worktrees");
    expect(config.project.max_parallel_workers).toBe(2);

    expect(config.limits.max_total_tasks).toBe(25);
    expect(config.limits.claude_max_session_budget_usd).toBe(25.0);
    expect(config.limits.stop_at_five_hour_quota_pct).toBe(90);
    expect(config.limits.stop_at_weekly_quota_pct).toBe(95);

    expect(config.routing.agy_fallback_to_claude).toBe(true);
    expect(config.routing.claude_categories).toContain("bug");
    expect(config.routing.agy_categories).toContain("test_coverage");

    expect(config.quality_gates.commands.length).toBeGreaterThan(0);
    expect(config.agy.binary).toBe("agy");
    expect(config.claude.binary).toBe("claude");
  });

  it("should parse partial config and preserve defaults for unspecified fields", () => {
    const partial = {
      limits: {
        max_total_tasks: 5,
        claude_max_turns_per_task: 10
      }
    };

    const config = ConfigSchema.parse(partial);

    expect(config.limits.max_total_tasks).toBe(5);
    expect(config.limits.claude_max_turns_per_task).toBe(10);
    expect(config.limits.claude_max_session_budget_usd).toBe(25.0); // Default preserved
    expect(config.project.base_branch).toBe("main"); // Default preserved
    expect(config.claude.model).toBe("sonnet"); // Default preserved
  });
});
