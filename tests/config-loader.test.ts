import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";
import { loadConfig, getWetDir } from "../src/config/loader.js";

describe("ConfigLoader & Path Resolution (Anti-EISDIR & cwd Independence)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wet-config-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should safely load config when passing a directory without wet.config.yaml (no EISDIR)", () => {
    // Calling loadConfig directly on a directory
    const config = loadConfig(tmpDir);

    expect(config).toBeDefined();
    expect(config.project.root).toBe(path.resolve(tmpDir));
    expect(config.project.base_branch).toBe("main");
  });

  it("should load wet.config.yaml inside directory when passing directory path", () => {
    const configFilePath = path.join(tmpDir, "wet.config.yaml");
    const customConfig = {
      project: {
        root: ".",
        base_branch: "develop"
      },
      limits: {
        max_total_tasks: 42
      }
    };
    fs.writeFileSync(configFilePath, yaml.stringify(customConfig), "utf-8");

    const config = loadConfig(tmpDir);

    expect(config).toBeDefined();
    expect(config.project.root).toBe(path.resolve(tmpDir));
    expect(config.project.base_branch).toBe("develop");
    expect(config.limits.max_total_tasks).toBe(42);
  });

  it("should preserve absolute project.root if specified in wet.config.yaml", () => {
    const customRoot = path.join(os.tmpdir(), "some-custom-absolute-root");
    const configFilePath = path.join(tmpDir, "wet.config.yaml");
    const customConfig = {
      project: {
        root: customRoot
      }
    };
    fs.writeFileSync(configFilePath, yaml.stringify(customConfig), "utf-8");

    const config = loadConfig(tmpDir);
    expect(config.project.root).toBe(customRoot);
  });

  it("should correctly resolve getWetDir to absolute path inside repoRoot regardless of cwd", () => {
    const resolvedWetDir = getWetDir(tmpDir);
    expect(resolvedWetDir).toBe(path.resolve(tmpDir, ".wet"));
    expect(path.isAbsolute(resolvedWetDir)).toBe(true);
  });
});
