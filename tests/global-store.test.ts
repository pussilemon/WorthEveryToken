import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  armProject,
  disarmProject,
  loadMachineState,
  updateActiveProject
} from "../src/config/global-store.js";

describe("GlobalStore Single Active Project Enforcement", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repoADir: string;
  let repoBDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wet-global-store-test-"));
    process.env.HOME = tmpHome;

    repoADir = path.join(tmpHome, "repo-a");
    repoBDir = path.join(tmpHome, "repo-b");
    fs.mkdirSync(repoADir, { recursive: true });
    fs.mkdirSync(repoBDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("enforces a single active project on the machine and detects conflicts", () => {
    // 1. Arm Repo A
    const resA = armProject(repoADir);
    expect(resA.success).toBe(true);
    expect(resA.activeProject?.repoName).toBe("repo-a");

    const state1 = loadMachineState();
    expect(state1.activeProject?.repoName).toBe("repo-a");

    // 2. Try to arm Repo B without force
    const resBConflict = armProject(repoBDir, { forceReplace: false });
    expect(resBConflict.success).toBe(false);
    expect(resBConflict.conflict).toBe(true);
    expect(resBConflict.existingProject?.repoName).toBe("repo-a");

    // Repo A should still be the active project
    const state2 = loadMachineState();
    expect(state2.activeProject?.repoName).toBe("repo-a");

    // 3. Arm Repo B with forceReplace: true
    const resBForce = armProject(repoBDir, { forceReplace: true });
    expect(resBForce.success).toBe(true);
    expect(resBForce.activeProject?.repoName).toBe("repo-b");

    const state3 = loadMachineState();
    expect(state3.activeProject?.repoName).toBe("repo-b");
  });

  it("disarms active project and clears state", () => {
    armProject(repoADir);
    const disarmed = disarmProject();
    expect(disarmed?.repoName).toBe("repo-a");

    const state = loadMachineState();
    expect(state.activeProject).toBeNull();
  });

  it("updates active project fields cleanly", () => {
    armProject(repoADir);
    updateActiveProject({
      status: "running_wave",
      auditPassCount: 1
    });

    const state = loadMachineState();
    expect(state.activeProject?.status).toBe("running_wave");
    expect(state.activeProject?.auditPassCount).toBe(1);
  });
});
