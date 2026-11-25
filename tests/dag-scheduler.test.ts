import { describe, it, expect } from "vitest";
import { DagScheduler } from "../src/core/dag-scheduler.js";
import type { Task } from "../src/config/schema.js";

function createMockTask(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    title: partial.title ?? `Task ${partial.id}`,
    category: partial.category ?? "bug",
    severity: partial.severity ?? "high",
    assigned_agent: partial.assigned_agent ?? "claude",
    target_files: partial.target_files ?? ["src/index.ts"],
    depends_on: partial.depends_on ?? [],
    description: partial.description ?? "Description of task with enough characters",
    acceptance_criteria: partial.acceptance_criteria ?? ["Criteria 1"],
    estimated_complexity: partial.estimated_complexity ?? "small",
    status: partial.status ?? "pending",
    retries: partial.retries ?? 0,
    commit_sha: null,
    failure_reason: null,
    digest: null
  };
}

describe("DagScheduler", () => {
  it("should sort tasks topologically", () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-002", depends_on: ["T-001"], target_files: ["src/b.ts"] }),
      createMockTask({ id: "T-001", target_files: ["src/a.ts"] }),
      createMockTask({ id: "T-003", depends_on: ["T-002"], target_files: ["src/c.ts"] })
    ];

    const sorted = scheduler.topologicalSort(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["T-001", "T-002", "T-003"]);
  });

  it("should throw error on circular dependency", () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", depends_on: ["T-002"], target_files: ["src/a.ts"] }),
      createMockTask({ id: "T-002", depends_on: ["T-001"], target_files: ["src/b.ts"] })
    ];

    expect(() => scheduler.detectCycles(tasks)).toThrow(/Circular dependency detected/);
  });

  it("should prevent concurrent execution of tasks with overlapping target_files", async () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", target_files: ["src/shared.ts", "src/a.ts"] }),
      createMockTask({ id: "T-002", target_files: ["src/shared.ts", "src/b.ts"] })
    ];

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    await scheduler.runScheduler(tasks, async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      currentConcurrent--;
      return "completed";
    });

    expect(maxConcurrent).toBe(1);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[1]?.status).toBe("completed");
  });

  it("should allow parallel execution for tasks with disjoint target_files", async () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", target_files: ["src/a.ts"] }),
      createMockTask({ id: "T-002", target_files: ["src/b.ts"] })
    ];

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    await scheduler.runScheduler(tasks, async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      currentConcurrent--;
      return "completed";
    });

    expect(maxConcurrent).toBe(2);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[1]?.status).toBe("completed");
  });

  it("should cascade dependency failure to dependent tasks", async () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", target_files: ["src/a.ts"] }),
      createMockTask({ id: "T-002", depends_on: ["T-001"], target_files: ["src/b.ts"] }),
      createMockTask({ id: "T-003", depends_on: ["T-002"], target_files: ["src/c.ts"] })
    ];

    await scheduler.runScheduler(tasks, async (task) => {
      if (task.id === "T-001") {
        return "failed";
      }
      return "completed";
    });

    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[1]?.status).toBe("skipped");
    expect(tasks[1]?.failure_reason).toContain("Dependency T-001 failed");
    expect(tasks[2]?.status).toBe("skipped");
    expect(tasks[2]?.failure_reason).toContain("Dependency T-002 failed");
  });

  it("should support resume when dependency is already completed", async () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", status: "completed", target_files: ["src/a.ts"] }),
      createMockTask({ id: "T-002", depends_on: ["T-001"], target_files: ["src/b.ts"] })
    ];

    let t2Executed = false;
    await scheduler.runScheduler(tasks, async (task) => {
      if (task.id === "T-002") {
        t2Executed = true;
        return "completed";
      }
      return "completed";
    });

    expect(t2Executed).toBe(true);
    expect(tasks[1]?.status).toBe("completed");
  });

  it("should preserve skipped status and not overwrite to failed", async () => {
    const scheduler = new DagScheduler({ maxParallelWorkers: 2 });
    const tasks: Task[] = [
      createMockTask({ id: "T-001", target_files: ["src/a.ts"] })
    ];

    await scheduler.runScheduler(tasks, async () => {
      return "skipped";
    });

    expect(tasks[0]?.status).toBe("skipped");
  });
});
