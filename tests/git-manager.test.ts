import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { GitManager } from "../src/git/git-manager.js";
import type { Task } from "../src/config/schema.js";

describe("GitManager Integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wqb-git-test-"));
    await execa("git", ["init", "-b", "main"], { cwd: tmpDir });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });

    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Initial", "utf-8");
    await execa("git", ["add", "README.md"], { cwd: tmpDir });
    await execa("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should rollback completely on failed task without polluting main or audit branch", async () => {
    const gitManager = new GitManager({
      repoRoot: tmpDir,
      baseBranch: "main",
      worktreeDir: ".wqb/worktrees"
    });

    await gitManager.checkPreflight();
    await gitManager.initAuditBranch();

    const { stdout: initialAuditSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });

    const task: Task = {
      id: "T-001",
      title: "Broken task that will fail",
      category: "bug",
      severity: "high",
      assigned_agent: "claude",
      target_files: ["src/bad.ts"],
      depends_on: [],
      description: "This task will fail during test",
      acceptance_criteria: ["Do something"],
      estimated_complexity: "small",
      status: "pending",
      retries: 3,
      commit_sha: null,
      failure_reason: null,
      digest: null
    };

    // Create worktree for task
    const worktreePath = await gitManager.createWorktree(task.id);
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Write file in worktree
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "bad.ts"), "// buggy code", "utf-8");

    // Simulate task failure after 3 retries: remove and rollback worktree
    await gitManager.removeWorktree(task.id);

    // Verify worktree is removed
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Verify temporary branch is removed
    const { stdout: branches } = await execa("git", ["branch", "--list", "wqb-task-T-001"], { cwd: tmpDir });
    expect(branches.trim()).toBe("");

    // Verify audit branch HEAD is identical to initial HEAD (not polluted)
    const { stdout: currentAuditSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    expect(currentAuditSha.trim()).toBe(initialAuditSha.trim());

    // Verify main branch HEAD is identical to initial commit
    await execa("git", ["checkout", "main"], { cwd: tmpDir });
    const { stdout: mainSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: tmpDir });
    expect(mainSha.trim()).toBe(initialAuditSha.trim());
  });

  it("should successfully commit and integrate a passed task", async () => {
    const gitManager = new GitManager({
      repoRoot: tmpDir,
      baseBranch: "main"
    });

    await gitManager.initAuditBranch();
    const task: Task = {
      id: "T-002",
      title: "Good fix",
      category: "bug",
      severity: "medium",
      assigned_agent: "claude",
      target_files: ["src/good.ts"],
      depends_on: [],
      description: "Working fix",
      acceptance_criteria: ["Done"],
      estimated_complexity: "small",
      status: "pending",
      retries: 0,
      commit_sha: null,
      failure_reason: null,
      digest: null
    };

    const worktreePath = await gitManager.createWorktree(task.id);
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "good.ts"), "export const ok = true;", "utf-8");

    const sha = await gitManager.commitTaskInWorktree(task.id, task, worktreePath);
    expect(sha).toBeDefined();

    const integrated = await gitManager.integrateTask(task.id, sha, worktreePath);
    expect(integrated).toBe(true);

    // Verify file exists on audit branch
    expect(fs.existsSync(path.join(tmpDir, "src", "good.ts"))).toBe(true);

    await gitManager.removeWorktree(task.id);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });
});
