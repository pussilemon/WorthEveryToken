import path from "node:path";
import pLimit from "p-limit";
import type { Task } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export interface SchedulerOptions {
  maxParallelWorkers: number;
}

export class DagScheduler {
  private readonly maxWorkers: number;
  private readonly activeFiles = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.maxWorkers = Math.max(1, options.maxParallelWorkers);
  }

  public normalizeFiles(files: string[]): string[] {
    return files.map((f) => path.normalize(f.trim()));
  }

  public detectCycles(tasks: Task[]): void {
    const taskMap = new Map<string, Task>(tasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (taskId: string, pathStack: string[]) => {
      visited.add(taskId);
      inStack.add(taskId);

      const task = taskMap.get(taskId);
      if (task) {
        for (const depId of task.depends_on) {
          if (!taskMap.has(depId)) {
            continue; // dependency might be external or already pruned
          }
          if (!visited.has(depId)) {
            dfs(depId, [...pathStack, depId]);
          } else if (inStack.has(depId)) {
            throw new Error(`Circular dependency detected: ${pathStack.join(" -> ")} -> ${depId}`);
          }
        }
      }

      inStack.delete(taskId);
    };

    for (const task of tasks) {
      if (!visited.has(task.id)) {
        dfs(task.id, [task.id]);
      }
    }
  }

  public topologicalSort(tasks: Task[]): Task[] {
    this.detectCycles(tasks);

    const taskMap = new Map<string, Task>(tasks.map((t) => [t.id, t]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const task of tasks) {
      inDegree.set(task.id, 0);
      dependents.set(task.id, []);
    }

    for (const task of tasks) {
      for (const depId of task.depends_on) {
        if (taskMap.has(depId)) {
          inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
          dependents.get(depId)?.push(task.id);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const sorted: Task[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentTask = taskMap.get(currentId);
      if (currentTask) {
        sorted.push(currentTask);
      }

      for (const dep of dependents.get(currentId) ?? []) {
        const newDeg = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) {
          queue.push(dep);
        }
      }
    }

    return sorted;
  }

  public cascadeDependencyFailure(failedTaskId: string, tasks: Task[]): void {
    const toSkip = new Set<string>();

    const markSkip = (parentTaskId: string) => {
      for (const t of tasks) {
        if (t.depends_on.includes(parentTaskId) && t.status === "pending") {
          t.status = "skipped";
          t.failure_reason = `Dependency ${parentTaskId} failed`;
          logger.warn({ taskId: t.id, failedDep: parentTaskId }, "Cascading dependency skip to task");
          toSkip.add(t.id);
          markSkip(t.id);
        }
      }
    };

    markSkip(failedTaskId);
  }

  public hasFileIntersection(taskFiles: string[]): boolean {
    const normalized = this.normalizeFiles(taskFiles);
    for (const file of normalized) {
      if (this.activeFiles.has(file)) {
        return true;
      }
    }
    return false;
  }

  public acquireFiles(taskFiles: string[]): boolean {
    if (this.hasFileIntersection(taskFiles)) {
      return false;
    }
    for (const file of this.normalizeFiles(taskFiles)) {
      this.activeFiles.add(file);
    }
    return true;
  }

  public releaseFiles(taskFiles: string[]): void {
    for (const file of this.normalizeFiles(taskFiles)) {
      this.activeFiles.delete(file);
    }
  }

  public async runScheduler(
    tasks: Task[],
    executeTask: (task: Task) => Promise<boolean>
  ): Promise<void> {
    const sorted = this.topologicalSort(tasks);
    const running = new Set<string>();
    const completed = new Set<string>();
    const limit = pLimit(this.maxWorkers);

    const canRun = (t: Task): boolean => {
      if (t.status !== "pending") return false;
      if (running.has(t.id)) return false;

      // Check all dependencies are completed
      for (const depId of t.depends_on) {
        if (!completed.has(depId)) {
          return false;
        }
      }

      // Check disjoint file lock
      if (this.hasFileIntersection(t.target_files)) {
        return false;
      }

      return true;
    };

    return new Promise((resolve, reject) => {
      let activeCount = 0;

      const scheduleNext = () => {
        let launchedAny = false;

        for (const task of sorted) {
          if (canRun(task) && activeCount < this.maxWorkers) {
            launchedAny = true;
            this.acquireFiles(task.target_files);
            running.add(task.id);
            task.status = "in_progress";
            activeCount++;

            limit(async () => {
              try {
                const success = await executeTask(task);
                if (success) {
                  task.status = "completed";
                  completed.add(task.id);
                } else {
                  task.status = "failed";
                  this.cascadeDependencyFailure(task.id, sorted);
                }
              } catch (err) {
                task.status = "failed";
                task.failure_reason = err instanceof Error ? err.message : String(err);
                this.cascadeDependencyFailure(task.id, sorted);
              } finally {
                this.releaseFiles(task.target_files);
                running.delete(task.id);
                activeCount--;
                scheduleNext();
              }
            }).catch(reject);
          }
        }

        // Check if finished
        const pendingCount = sorted.filter((t) => t.status === "pending" || t.status === "in_progress").length;
        if (pendingCount === 0 && activeCount === 0) {
          resolve();
        } else if (!launchedAny && activeCount === 0 && pendingCount > 0) {
          // Deadlock or unresolvable dependencies
          logger.warn("Scheduler reached state with no runnable tasks but pending tasks remain");
          for (const t of sorted.filter((task) => task.status === "pending")) {
            t.status = "skipped";
            t.failure_reason = "Unmet dependency or lock starvation";
          }
          resolve();
        }
      };

      scheduleNext();
    });
  }
}
