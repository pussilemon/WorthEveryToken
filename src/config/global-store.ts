import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import {
  GlobalConfigSchema,
  MachineStateSchema,
  type WetGlobalConfig,
  type MachineState,
  type ActiveProject,
  type LastKnownUsage
} from "./schema.js";
import { logger } from "../utils/logger.js";

export function getGlobalWetDir(): string {
  const dir = path.join(os.homedir(), ".wet");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getGlobalConfigPath(): string {
  return path.join(getGlobalWetDir(), "config.yaml");
}

export function getMachineStatePath(): string {
  return path.join(getGlobalWetDir(), "state.json");
}

export function hasGlobalConfig(): boolean {
  return fs.existsSync(getGlobalConfigPath());
}

export function loadGlobalConfig(): WetGlobalConfig {
  const configPath = getGlobalConfigPath();
  if (!fs.existsSync(configPath)) {
    return GlobalConfigSchema.parse({});
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(raw);
    return GlobalConfigSchema.parse(parsed ?? {});
  } catch (err) {
    logger.warn({ err }, "Failed to parse ~/.wet/config.yaml, falling back to defaults");
    return GlobalConfigSchema.parse({});
  }
}

export function saveGlobalConfig(config: WetGlobalConfig): void {
  const configPath = getGlobalConfigPath();
  fs.writeFileSync(configPath, yaml.stringify(config), "utf-8");
  logger.info({ configPath }, "Saved global configuration");
}

export function loadMachineState(): MachineState {
  const statePath = getMachineStatePath();
  if (!fs.existsSync(statePath)) {
    return MachineStateSchema.parse({});
  }
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return MachineStateSchema.parse(parsed ?? {});
  } catch (err) {
    logger.warn({ err }, "Failed to parse ~/.wet/state.json, initializing clean state");
    return MachineStateSchema.parse({});
  }
}

export function saveMachineState(state: MachineState): void {
  const statePath = getMachineStatePath();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ArmProjectResult {
  success: boolean;
  conflict?: boolean;
  existingProject?: ActiveProject;
  activeProject?: ActiveProject;
}

export function armProject(
  repoPath: string,
  options: { forceReplace?: boolean } = {}
): ArmProjectResult {
  const state = loadMachineState();
  const canonicalPath = fs.realpathSync(path.resolve(repoPath));

  if (state.activeProject && state.activeProject.repoPath !== canonicalPath) {
    if (!options.forceReplace) {
      return {
        success: false,
        conflict: true,
        existingProject: state.activeProject
      };
    }

    // Force replacement: terminate any active process running on the previous project
    if (state.activeRunPid && isPidAlive(state.activeRunPid)) {
      try {
        process.kill(state.activeRunPid, "SIGTERM");
        logger.info({ pid: state.activeRunPid }, "Sent SIGTERM to previous active run PID");
      } catch (err) {
        logger.warn({ err }, "Failed to terminate previous run PID");
      }
    }
  }

  const newProject: ActiveProject = {
    repoPath: canonicalPath,
    repoName: path.basename(canonicalPath),
    armedAt: new Date().toISOString(),
    auditBranch: null,
    status: "armed",
    auditPassCount: 0,
    nextWakeAt: null,
    lastWaveStartedAt: null,
    lastWaveWeeklyPctBefore: null,
    lockedCycleResetAt: null,
    cyclePeakUsedPct: null,
    lastRunError: null
  };

  state.activeProject = newProject;
  state.activeRunPid = null;
  saveMachineState(state);

  logger.info({ project: newProject.repoName, path: canonicalPath }, "Armed project as active");
  return {
    success: true,
    activeProject: newProject
  };
}

export function disarmProject(): ActiveProject | null {
  const state = loadMachineState();
  const previous = state.activeProject;
  if (state.activeRunPid && isPidAlive(state.activeRunPid)) {
    try {
      process.kill(state.activeRunPid, "SIGTERM");
    } catch {
      // Ignore
    }
  }
  state.activeProject = null;
  state.activeRunPid = null;
  saveMachineState(state);
  logger.info("Disarmed active project");
  return previous;
}

export function isCurrentProjectActive(repoPath: string): boolean {
  const state = loadMachineState();
  if (!state.activeProject) return false;
  try {
    const canonicalPath = fs.realpathSync(path.resolve(repoPath));
    return state.activeProject.repoPath === canonicalPath;
  } catch {
    return false;
  }
}

export function updateMachineState(updater: (state: MachineState) => void): MachineState {
  const state = loadMachineState();
  updater(state);
  saveMachineState(state);
  return state;
}

export function updateActiveProject(
  updater: Partial<ActiveProject> | ((proj: ActiveProject) => void)
): ActiveProject | null {
  const state = loadMachineState();
  if (!state.activeProject) return null;
  if (typeof updater === "function") {
    updater(state.activeProject);
  } else {
    Object.assign(state.activeProject, updater);
  }
  saveMachineState(state);
  return state.activeProject;
}

export function updateLastKnownUsage(usage: LastKnownUsage): void {
  updateMachineState((state) => {
    state.lastKnownUsage = usage;
  });
}
