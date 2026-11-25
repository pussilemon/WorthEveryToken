import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { GitManager } from "../src/git/git-manager.js";
import type { Task } from "../src/config/schema.js";

describe("Zero-Touch Git Invisibility (src/git/git-manager.ts)", () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "wet-git-invis-"));
    await execa("git", ["init"], { cwd: tmpRepo });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tmpRepo });
    await execa("git", ["config", "user.email", "test@user.com"], { cwd: tmpRepo });

    // Initial base commit on main branch
    fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "src", "index.ts"), "export const app = 'main';\n", "utf-8");
    await execa("git", ["add", "."], { cwd: tmpRepo });
    await execa("git", ["commit", "-m", "Initial commit on main"], { cwd: tmpRepo });
    await execa("git", ["branch", "-M", "main"], { cwd: tmpRepo });

    // Switch to user working branch
    await execa("git", ["checkout", "-b", "feature/user-work"], { cwd: tmpRepo });

    // User is actively editing a dirty uncommitted file in repoRoot
    fs.writeFileSync(path.join(tmpRepo, "user-dirty-wip.txt"), "IMPORTANT USER EDITS: DO NOT TOUCH!\n", "utf-8");
  });

  afterEach(async () => {
    try {
      // Clean up worktrees before removing directory to avoid git lock issues
      await execa("git", ["worktree", "prune"], { cwd: tmpRepo }).catch(() => {});
    } catch {
      // Ignore
    }
    if (fs.existsSync(tmpRepo)) {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("should NEVER switch or checkout branches in repoRoot and preserve user working copy 100%", async () => {
    const gitManager = new GitManager({
      repoRoot: tmpRepo,
      baseBranch: "main"
    });

    // 1. Verify preflight succeeds despite dirty uncommitted user edits in repoRoot
    await expect(gitManager.checkPreflight()).resolves.not.toThrow();

    // 2. Initialize audit branch (must create branch & dedicated .wet/audit-head worktree)
    await gitManager.initAuditBranch();

    // Check branch in repoRoot: MUST STILL BE feature/user-work!
    const { stdout: branchAfterInit } = await execa("git", ["branch", "--show-current"], { cwd: tmpRepo });
    expect(branchAfterInit.trim()).toBe("feature/user-work");

    // Check user dirty file in repoRoot: MUST BE 100% UNTOUCHED!
    const dirtyFileContent = fs.readFileSync(path.join(tmpRepo, "user-dirty-wip.txt"), "utf-8");
    expect(dirtyFileContent).toBe("IMPORTANT USER EDITS: DO NOT TOUCH!\n");

    // 3. Create isolated worktree for task T-001
    const task: Task = {
      id: "T-001",
      title: "Add zero-touch feature",
      category: "feature",
      severity: "medium",
      assigned_agent: "claude",
      target_files: ["src/feature.ts"],
      depends_on: [],
      description: "Implement zero-touch feature",
      acceptance_criteria: ["Must not pollute repoRoot"],
      estimated_complexity: "small",
      status: "pending",
      retries: 0,
      commit_sha: null,
      failure_reason: null,
      digest: null
    };

    const taskWorktree = await gitManager.createWorktree(task.id);
    expect(fs.existsSync(taskWorktree)).toBe(true);

    // Modify file inside isolated task worktree
    fs.writeFileSync(
      path.join(taskWorktree, "src", "feature.ts"),
      "export const zeroTouch = true;\n",
      "utf-8"
    );

    // 4. Commit inside task worktree
    const commitSha = await gitManager.commitTaskInWorktree(task.id, task, taskWorktree);
    expect(commitSha).toBeDefined();

    // 5. Integrate task commit into audit branch
    const integrated = await gitManager.integrateTask(task.id, commitSha, taskWorktree);
    expect(integrated).toBe(true);

    // 6. Remove task worktree
    await gitManager.removeWorktree(task.id);
    expect(fs.existsSync(taskWorktree)).toBe(false);

    // ─── STRICT ZERO-TOUCH VERIFICATIONS IN REPOROOT ───

    // Verification A: Current branch in repoRoot is STILL feature/user-work
    const { stdout: branchFinal } = await execa("git", ["branch", "--show-current"], { cwd: tmpRepo });
    expect(branchFinal.trim()).toBe("feature/user-work");

    // Verification B: User dirty uncommitted file is STILL completely untouched
    expect(fs.existsSync(path.join(tmpRepo, "user-dirty-wip.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpRepo, "user-dirty-wip.txt"), "utf-8")).toBe(
      "IMPORTANT USER EDITS: DO NOT TOUCH!\n"
    );

    // Verification C: The task's new file does NOT exist in repoRoot
    expect(fs.existsSync(path.join(tmpRepo, "src", "feature.ts"))).toBe(false);

    // Verification D: The task's new file exists cleanly in the audit branch (.wet/audit-head and git show)
    const { stdout: showContent } = await execa(
      "git",
      ["show", `${gitManager.auditBranch}:src/feature.ts`],
      { cwd: tmpRepo }
    );
    expect(showContent.trim()).toBe("export const zeroTouch = true;");

    // Verification E: The audit branch HEAD commit message mentions task ID
    const { stdout: logMsg } = await execa(
      "git",
      ["log", "-1", "--format=%s", gitManager.auditBranch],
      { cwd: tmpRepo }
    );
    expect(logMsg).toContain("T-001");
  });
});
