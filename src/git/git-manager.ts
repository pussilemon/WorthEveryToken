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
  public readonly auditHeadDir: string;
  public readonly auditWorktreePath: string;
  private integrationMutex: Promise<void> = Promise.resolve();

  constructor(options: GitManagerOptions = {}) {
    this.repoRoot = path.resolve(options.repoRoot ?? ".");
    this.baseBranch = options.baseBranch ?? "main";
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    this.auditBranch = `${options.auditBranchPrefix ?? "ai-weekend-audit"}-${dateStr}`;
    this.worktreeDir = path.resolve(this.repoRoot, options.worktreeDir ?? ".wet/worktrees");
    this.auditHeadDir = path.resolve(this.repoRoot, ".wet/audit-head");
    this.auditWorktreePath = path.resolve(this.repoRoot, ".wet/audit-worktree");
  }

  private async execGit(args: string[], cwd = this.repoRoot): Promise<{ stdout: string; stderr: string }> {
    return execa("git", args, { cwd });
  }

  public async checkPreflight(): Promise<void> {
    // Zero-Touch Git: We verify that repoRoot is a valid Git repository.
    // We intentionally do NOT fail on dirty working trees because wet NEVER checks out
    // or switches branches in repoRoot.
    await this.execGit(["rev-parse", "--git-dir"]);
  }

  public async createAuditWorktree(): Promise<string> {
    await this.removeAuditWorktree();
    fs.mkdirSync(path.dirname(this.auditWorktreePath), { recursive: true });

    let baseRef = this.baseBranch;
    try {
      await this.execGit(["rev-parse", "--verify", baseRef]);
    } catch {
      baseRef = "HEAD";
    }

    try {
      await this.execGit(["worktree", "add", "--detach", this.auditWorktreePath, baseRef]);
    } catch {
      await this.execGit(["worktree", "prune"]);
      await this.execGit(["worktree", "add", "--detach", "--force", this.auditWorktreePath, baseRef]);
    }

    this.linkDependencyDirectories(this.auditWorktreePath);
    return this.auditWorktreePath;
  }

  public async removeAuditWorktree(): Promise<void> {
    if (fs.existsSync(this.auditWorktreePath)) {
      try {
        const { stdout } = await this.execGit(["status", "--porcelain"], this.auditWorktreePath);
        if (stdout.trim().length > 0) {
          logger.warn(
            { modifications: stdout.trim() },
            "Audit agent attempted modifications inside isolated audit worktree! Changes discarded safely."
          );
        }
      } catch {
        // Ignore
      }

      this.unlinkDependencyDirectories(this.auditWorktreePath);
      try {
        await this.execGit(["worktree", "remove", "--force", this.auditWorktreePath]);
      } catch {
        try {
          fs.rmSync(this.auditWorktreePath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }

      try {
        await this.execGit(["worktree", "prune"]);
      } catch {
        // Ignore
      }
    }
  }

  public async ensureCleanPostAudit(): Promise<void> {
    // Zero-Touch Git: Non-destructive no-op.
    // Phase 1 Audit runs entirely in an isolated detached worktree (.wet/audit-worktree).
    // repoRoot is NEVER modified or reset.
  }

  public async initAuditBranch(resume = false): Promise<string> {
    const { stdout: branches } = await this.execGit(["branch", "--list", this.auditBranch]);
    const branchExists = branches.trim().length > 0;

    if (!branchExists) {
      logger.info({ branch: this.auditBranch, base: this.baseBranch }, "Creating new audit branch from base (Zero-Touch)");
      try {
        await this.execGit(["branch", this.auditBranch, this.baseBranch]);
      } catch {
        await this.execGit(["branch", this.auditBranch, "HEAD"]);
      }
    } else if (!resume) {
      logger.info({ branch: this.auditBranch }, "Audit branch already exists. Using existing branch.");
    }

    // Zero-Touch Git: Maintain dedicated hidden worktree .wet/audit-head attached to auditBranch
    fs.mkdirSync(path.dirname(this.auditHeadDir), { recursive: true });
    if (!fs.existsSync(this.auditHeadDir)) {
      try {
        await this.execGit(["worktree", "add", this.auditHeadDir, this.auditBranch]);
      } catch {
        await this.execGit(["worktree", "prune"]);
        await this.execGit(["worktree", "add", "--force", this.auditHeadDir, this.auditBranch]);
      }
    }

    return this.auditBranch;
  }

  public async createWorktree(taskId: string): Promise<string> {
    const taskWorktreePath = path.join(this.worktreeDir, taskId);
    const taskBranch = `wet-task-${taskId}`;

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

    // Symlink dependency directories from repoRoot if they exist
    this.linkDependencyDirectories(taskWorktreePath);

    return taskWorktreePath;
  }

  private linkDependencyDirectories(worktreePath: string): void {
    const depDirs = ["node_modules", ".venv", "venv"];
    for (const dep of depDirs) {
      const srcPath = path.join(this.repoRoot, dep);
      const destPath = path.join(worktreePath, dep);

      if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
        try {
          fs.symlinkSync(srcPath, destPath, "junction");
          logger.debug({ dep, worktreePath }, "Symlinked dependency directory into worktree");
        } catch (err) {
          logger.warn({ dep, err }, "Failed to symlink dependency directory");
        }
      }
    }
  }

  private unlinkDependencyDirectories(worktreePath: string): void {
    const depDirs = ["node_modules", ".venv", "venv"];
    for (const dep of depDirs) {
      const destPath = path.join(worktreePath, dep);
      try {
        if (fs.existsSync(destPath)) {
          const stat = fs.lstatSync(destPath);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(destPath);
          }
        }
      } catch {
        // Ignore unlink errors
      }
    }
  }

  public async commitTaskInWorktree(taskId: string, task: Task, worktreePath: string): Promise<string> {
    const { stdout: status } = await this.execGit(["status", "--porcelain"], worktreePath);
    const meaningfulChanges = status
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => {
        if (l.length === 0) return false;
        if (l.includes(".wet")) return false;
        if (l.includes("node_modules") || l.includes(".venv") || l.includes("venv")) return false;
        return true;
      });

    if (meaningfulChanges.length === 0) {
      throw new Error("No file changes produced by agent");
    }

    await this.execGit(["add", "-A", ":!.wet"], worktreePath);

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
    const release = await this.acquireMutex();

    try {
      logger.info({ taskId, commitSha }, "Integrating task commit into audit branch via .wet/audit-head");

      // Cherry-pick strictly inside .wet/audit-head — ZERO touch on repoRoot HEAD
      try {
        await this.execGit(["cherry-pick", commitSha], this.auditHeadDir);
        logger.info({ taskId, commitSha }, "Cherry-pick integrated cleanly into .wet/audit-head");
        return true;
      } catch (cherryPickErr) {
        logger.warn({ taskId, err: cherryPickErr }, "Cherry-pick conflict detected during integration, attempting rebase");
        await this.execGit(["cherry-pick", "--abort"], this.auditHeadDir).catch(() => {});

        // Rebase task worktree on latest auditBranch
        try {
          await this.execGit(["rebase", this.auditBranch], worktreePath);
        } catch {
          await this.execGit(["rebase", "--abort"], worktreePath).catch(() => {});
          logger.error({ taskId }, "Rebase failed due to unresolvable conflict");
          return false;
        }

        if (onConflictRetry) {
          const retriedPassed = await onConflictRetry();
          if (retriedPassed) {
            const { stdout: newSha } = await this.execGit(["rev-parse", "HEAD"], worktreePath);
            await this.execGit(["cherry-pick", newSha.trim()], this.auditHeadDir);
            logger.info({ taskId, newSha: newSha.trim() }, "Rebased commit integrated cleanly into .wet/audit-head");
            return true;
          }
        }

        return false;
      }
    } finally {
      release();
    }
  }

  public async removeWorktree(taskId: string): Promise<void> {
    const taskWorktreePath = path.join(this.worktreeDir, taskId);
    const taskBranch = `wet-task-${taskId}`;

    this.unlinkDependencyDirectories(taskWorktreePath);

    try {
      await this.execGit(["worktree", "remove", "--force", taskWorktreePath]);
    } catch {
      // Worktree might not exist or might already be removed
    }

    if (fs.existsSync(taskWorktreePath)) {
      try {
        this.unlinkDependencyDirectories(taskWorktreePath);
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
    logger.info("Cleaning up all wet worktrees and temporary branches...");
    try {
      const { stdout } = await this.execGit(["worktree", "list", "--porcelain"]);
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("worktree ") && line.includes(".wet")) {
          const wtPath = line.replace("worktree ", "").trim();
          this.unlinkDependencyDirectories(wtPath);
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
      const { stdout: branches } = await this.execGit(["branch", "--list", "wet-task-*"]);
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
