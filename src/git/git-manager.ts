import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { Task } from "../config/schema.js";

export interface GitManagerOptions {
  repoRoot?: string;
  baseBranch?: string;
  auditBranchPrefix?: string;
  worktreeDir?: string;
}

export class GitManager {
  public readonly repoRoot: string;
  public readonly baseBranch: string;
  public readonly auditBranch: string;
  public readonly worktreeDir: string;
  private integrationMutex: Promise<void> = Promise.resolve();

  constructor(options: GitManagerOptions = {}) {
    this.repoRoot = path.resolve(options.repoRoot ?? ".");
    this.baseBranch = options.baseBranch ?? "main";
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    this.auditBranch = `${options.auditBranchPrefix ?? "ai-weekend-audit"}-${dateStr}`;
    this.worktreeDir = path.resolve(this.repoRoot, options.worktreeDir ?? ".wqb/worktrees");
  }

  private async execGit(args: string[], cwd = this.repoRoot): Promise<{ stdout: string; stderr: string }> {
    return execa("git", args, { cwd });
  }

  public async checkPreflight(): Promise<void> {
    const { stdout } = await this.execGit(["status", "--porcelain"]);
    const dirtyFiles = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes(".wqb"));

    if (dirtyFiles.length > 0) {
      throw new Error(
        `Pre-flight check failed: Working tree has uncommitted changes:\n${dirtyFiles.join("\n")}`
      );
    }
  }

  public async initAuditBranch(resume = false): Promise<string> {
    const { stdout: branches } = await this.execGit(["branch", "--list", this.auditBranch]);
    const branchExists = branches.trim().length > 0;

    if (branchExists) {
      if (!resume) {
        logger.info({ branch: this.auditBranch }, "Audit branch already exists. Resuming on existing branch.");
      }
      await this.execGit(["checkout", this.auditBranch]);
    } else {
      logger.info({ branch: this.auditBranch, base: this.baseBranch }, "Creating new audit branch from base");
      await this.execGit(["checkout", "-b", this.auditBranch, this.baseBranch]);
    }

    return this.auditBranch;
  }

  public async createWorktree(taskId: string): Promise<string> {
    const taskWorktreePath = path.join(this.worktreeDir, taskId);
    const taskBranch = `wqb-task-${taskId}`;

    fs.mkdirSync(this.worktreeDir, { recursive: true });

    // Ensure stale worktree or branch is cleared if present
    await this.removeWorktree(taskId);
    try {
      await this.execGit(["branch", "-D", taskBranch]);
    } catch {
      // Branch may not exist, ignore
    }

    // Create worktree with dedicated branch branching off auditBranch HEAD
    await this.execGit([
      "worktree",
      "add",
      "-b",
      taskBranch,
      taskWorktreePath,
      this.auditBranch
    ]);

    return taskWorktreePath;
  }

  public async commitTaskInWorktree(taskId: string, task: Task, worktreePath: string): Promise<string> {
    await this.execGit(["add", "-A", ":!.wqb"], worktreePath);

    const message = `audit(${task.category}): ${task.title} [${taskId}]`;
    await this.execGit(["commit", "-m", message], worktreePath);

    const { stdout: sha } = await this.execGit(["rev-parse", "HEAD"], worktreePath);
    return sha.trim();
  }

  public async integrateTask(
    taskId: string,
    commitSha: string,
    worktreePath: string,
    onConflictRetry?: () => Promise<boolean>
  ): Promise<boolean> {
    // Synchronize integration using mutex to avoid git lock races
    const release = await this.acquireMutex();

    try {
      logger.info({ taskId, commitSha }, "Integrating task commit into audit branch");
      await this.execGit(["checkout", this.auditBranch]);

      try {
        await this.execGit(["cherry-pick", commitSha]);
        logger.info({ taskId, commitSha }, "Cherry-pick integrated cleanly");
        return true;
      } catch (cherryPickErr) {
        logger.warn({ taskId, err: cherryPickErr }, "Cherry-pick conflict detected during integration, attempting rebase");
        await this.execGit(["cherry-pick", "--abort"]).catch(() => {});

        // Rebase task worktree on latest auditBranch
        try {
          await this.execGit(["rebase", this.auditBranch], worktreePath);
        } catch {
          await this.execGit(["rebase", "--abort"], worktreePath).catch(() => {});
          logger.error({ taskId }, "Rebase failed due to unresolvable conflict");
          return false;
        }

        // Re-run quality gate verification if hook provided
        if (onConflictRetry) {
          const pass = await onConflictRetry();
          if (!pass) {
            logger.error({ taskId }, "Quality gates failed after rebase");
            return false;
          }
        }

        // Get new commit SHA after rebase and retry cherry-pick
        const { stdout: newSha } = await this.execGit(["rev-parse", "HEAD"], worktreePath);
        await this.execGit(["checkout", this.auditBranch]);
        await this.execGit(["cherry-pick", newSha.trim()]);
        return true;
      }
    } finally {
      release();
    }
  }

  public async removeWorktree(taskId: string): Promise<void> {
    const taskWorktreePath = path.join(this.worktreeDir, taskId);
    const taskBranch = `wqb-task-${taskId}`;

    try {
      await this.execGit(["worktree", "remove", "--force", taskWorktreePath]);
    } catch {
      // Worktree might not exist or might already be removed
    }

    if (fs.existsSync(taskWorktreePath)) {
      try {
        fs.rmSync(taskWorktreePath, { recursive: true, force: true });
      } catch {
        // Ignore fs removal errors
      }
    }

    try {
      await this.execGit(["branch", "-D", taskBranch]);
    } catch {
      // Branch might not exist
    }

    try {
      await this.execGit(["worktree", "prune"]);
    } catch {
      // Ignore prune errors
    }
  }

  public async cleanupAll(): Promise<void> {
    logger.info("Cleaning up all wqb worktrees and temporary branches...");
    try {
      const { stdout } = await this.execGit(["worktree", "list", "--porcelain"]);
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("worktree ") && line.includes(".wqb/worktrees")) {
          const wtPath = line.replace("worktree ", "").trim();
          try {
            await this.execGit(["worktree", "remove", "--force", wtPath]);
          } catch {
            // Ignore
          }
        }
      }
      await this.execGit(["worktree", "prune"]);
    } catch {
      // Ignore
    }

    try {
      const { stdout: branches } = await this.execGit(["branch", "--list", "wqb-task-*"]);
      for (const b of branches.split("\n")) {
        const branchName = b.replace("*", "").trim();
        if (branchName) {
          try {
            await this.execGit(["branch", "-D", branchName]);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  public async getDiff(worktreePath: string): Promise<string> {
    const { stdout } = await this.execGit(["diff", "HEAD"], worktreePath);
    return stdout;
  }

  private acquireMutex(): Promise<() => void> {
    let releaseFunc: () => void = () => {};
    const nextPromise = new Promise<void>((resolve) => {
      releaseFunc = resolve;
    });

    const currentPromise = this.integrationMutex;
    this.integrationMutex = this.integrationMutex.then(() => nextPromise);

    return currentPromise.then(() => releaseFunc);
  }
}
