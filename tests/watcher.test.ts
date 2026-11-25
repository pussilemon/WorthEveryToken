import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWatchTick, isPidAlive } from "../src/scheduler/watcher.js";
import {
  armProject,
  loadMachineState,
  saveMachineState,
  updateActiveProject,
  saveGlobalConfig,
  loadGlobalConfig
} from "../src/config/global-store.js";

describe("Watcher & Overlap Prevention", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repoDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wet-watcher-test-"));
    process.env.HOME = tmpHome;

    repoDir = path.join(tmpHome, "test-repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Use fast custom provider during tests to prevent PTY/CLI timeouts
    const cfg = loadGlobalConfig();
    saveGlobalConfig({
      ...cfg,
      provider: "custom",
      custom_provider: {
        binary: "echo",
        audit_args: ["audit"],
        exec_args: ["exec"],
        usage_cmd: "echo Weekly limit: 50% used · Resets Mon 8:00 AM",
        use_pty: false
      }
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("checks PID liveness accurately", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(99999999)).toBe(false);
  });

  it("returns NONE and does nothing when no project is armed", async () => {
    const result = await runWatchTick();
    expect(result.executed).toBe(false);
    expect(result.action).toBe("NONE");
  });

  it("skips tick when active project is paused", async () => {
    armProject(repoDir);
    updateActiveProject({ status: "paused" });

    const result = await runWatchTick();
    expect(result.executed).toBe(false);
    expect(result.action).toBe("PAUSED");
  });

  it("prevents overlapping execution when activeRunPid is alive", async () => {
    armProject(repoDir);
    const state = loadMachineState();
    state.activeRunPid = process.pid; // Current process is alive
    saveMachineState(state);

    const result = await runWatchTick();
    expect(result.executed).toBe(false);
    expect(result.action).toBe("RUNNING");
    expect(result.reason).toContain(String(process.pid));
  });

  it("clears stale activeRunPid when process is dead", async () => {
    armProject(repoDir);
    const state = loadMachineState();
    state.activeRunPid = 99999999; // Dead PID
    saveMachineState(state);

    const result = await runWatchTick();
    expect(result.action).not.toBe("RUNNING");

    const finalState = loadMachineState();
    expect(finalState.activeRunPid).toBeNull();
  });
});
