import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AgyAdapter,
  normalizeAgyOutput,
  parseAgyModelsOutput,
  selectTopAgyModel
} from "../src/adapters/agy-adapter.js";
import { parseExitSignal, parseDigest } from "../src/adapters/agent-adapter.js";

describe("AgyAdapter", () => {
  let tmpDir: string;
  let hangingScriptPath: string;
  let workingScriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wet-agy-test-"));

    // 1. Script that hangs silently without output (simulating issue #318 non-TTY hang)
    hangingScriptPath = path.join(tmpDir, "mock-hanging-agy.sh");
    fs.writeFileSync(
      hangingScriptPath,
      `#!/bin/bash
sleep 10
`,
      { mode: 0o755 }
    );

    // 2. Script that outputs valid digest and signal
    workingScriptPath = path.join(tmpDir, "mock-working-agy.sh");
    fs.writeFileSync(
      workingScriptPath,
      `#!/bin/bash
echo '<WET_DIGEST>'
echo '{"files_changed": ["src/util.ts"], "summary": "Added tests", "tests_added": 2, "risks": []}'
echo '</WET_DIGEST>'
echo '<WET_EXIT_SIGNAL status="DONE"/>'
exit 0
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("should trigger silence watchdog and terminate hanging agy process", async () => {
    const adapter = new AgyAdapter({
      binary: hangingScriptPath,
      usePty: true,
      silenceWatchdogSec: 1,
      wallClockTimeoutSec: 5
    });

    const result = await adapter.execute("Do task", {
      cwd: tmpDir
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/silence watchdog/i);
  });

  it("should successfully parse valid agy digest and exit signal", async () => {
    const adapter = new AgyAdapter({
      binary: workingScriptPath,
      usePty: true,
      silenceWatchdogSec: 5,
      wallClockTimeoutSec: 10
    });

    const result = await adapter.execute("Do task", {
      cwd: tmpDir
    });

    expect(result.status).toBe("DONE");
    expect(result.digest).not.toBeNull();
    expect(result.digest?.files_changed).toEqual(["src/util.ts"]);
    expect(result.digest?.tests_added).toBe(2);
  });

  it("should strip ANSI sequences and unwrap JSON output correctly", () => {
    const rawAnsiWrapped = `\u001b[32mStarting...\u001b[0m\r\n{"response": "<WET_DIGEST>\\n{\\"files_changed\\": [\\"src/foo.ts\\"], \\"summary\\": \\"Cleaned types\\", \\"tests_added\\": 0, \\"risks\\": []}\\n</WET_DIGEST>\\n<WET_EXIT_SIGNAL status=\\"DONE\\"/>"}`;

    const normalized = normalizeAgyOutput(rawAnsiWrapped);
    expect(normalized).not.toContain("\u001b[32m");
    expect(normalized).toContain("<WET_DIGEST>");
    expect(normalized).toContain("<WET_EXIT_SIGNAL status=\"DONE\"/>");

    const signal = parseExitSignal(normalized);
    expect(signal.status).toBe("DONE");

    const digest = parseDigest(normalized);
    expect(digest?.files_changed).toEqual(["src/foo.ts"]);
    expect(digest?.summary).toBe("Cleaned types");
  });

  it("should successfully complete runAudit() and runRepair() without requiring <WET_DIGEST>", async () => {
    const auditScriptPath = path.join(tmpDir, "mock-audit-agy.sh");
    fs.writeFileSync(
      auditScriptPath,
      `#!/bin/bash
echo '<WET_BACKLOG_JSON>{"project":"test","generated_at":"2026-11-25T10:00:00.000Z","base_branch":"main","audit_branch":"ai-audit","tasks":[]}</WET_BACKLOG_JSON>'
echo '<WET_EXIT_SIGNAL status="DONE"/>'
exit 0
`,
      { mode: 0o755 }
    );

    const adapter = new AgyAdapter({
      binary: auditScriptPath,
      usePty: true,
      silenceWatchdogSec: 5,
      wallClockTimeoutSec: 10
    });

    const auditResult = await adapter.runAudit("Run audit", tmpDir);
    expect(auditResult.status).toBe("DONE");
    expect(auditResult.digest).toBeNull();

    const repairResult = await adapter.runRepair("Run repair", tmpDir);
    expect(repairResult.status).toBe("DONE");
  });

  it("should invoke runAudit() with --mode plan and strictly exclude write permissions", async () => {
    const argLogPath = path.join(tmpDir, "args-audit.log");
    const spyScript = path.join(tmpDir, "mock-spy-audit.sh");
    fs.writeFileSync(
      spyScript,
      `#!/bin/bash
echo "$@" > "${argLogPath}"
echo '<WET_EXIT_SIGNAL status="DONE"/>'
exit 0
`,
      { mode: 0o755 }
    );

    const adapter = new AgyAdapter({
      binary: spyScript,
      usePty: false
    });

    const result = await adapter.runAudit("Analyze repo", tmpDir, {
      model: "gemini-4-hydrogen-xhigh",
      extraFlags: ["--effort", "max"]
    });

    expect(result.status).toBe("DONE");
    const recordedArgs = fs.readFileSync(argLogPath, "utf-8");
    expect(recordedArgs).toContain("--mode plan");
    expect(recordedArgs).not.toContain("--dangerously-skip-permissions");
    expect(recordedArgs).not.toContain("accept-edits");
    expect(recordedArgs).toContain("--model gemini-4-hydrogen-xhigh");
  });

  it("should invoke runTask() and runRepair() with --mode accept-edits and --dangerously-skip-permissions", async () => {
    const argLogPath = path.join(tmpDir, "args-task.log");
    const spyScript = path.join(tmpDir, "mock-spy-task.sh");
    fs.writeFileSync(
      spyScript,
      `#!/bin/bash
echo "$@" > "${argLogPath}"
echo '<WET_DIGEST>{"files_changed": ["src/fix.ts"], "summary": "Fixed", "tests_added": 1, "risks": []}</WET_DIGEST>'
echo '<WET_EXIT_SIGNAL status="DONE"/>'
exit 0
`,
      { mode: 0o755 }
    );

    const adapter = new AgyAdapter({
      binary: spyScript,
      usePty: false
    });

    const result = await adapter.runTask("Fix bug", tmpDir, {
      model: "gemini-4-hydrogen-xhigh",
      extraFlags: ["--effort", "max"]
    });

    expect(result.status).toBe("DONE");
    const recordedArgs = fs.readFileSync(argLogPath, "utf-8");
    expect(recordedArgs).toContain("--mode accept-edits");
    expect(recordedArgs).toContain("--dangerously-skip-permissions");
    expect(recordedArgs).toContain("--effort max");
    expect(recordedArgs).toContain("--model gemini-4-hydrogen-xhigh");

    const repairLogPath = path.join(tmpDir, "args-repair.log");
    const spyRepairScript = path.join(tmpDir, "mock-spy-repair.sh");
    fs.writeFileSync(
      spyRepairScript,
      `#!/bin/bash
echo "$@" > "${repairLogPath}"
echo '<WET_EXIT_SIGNAL status="DONE"/>'
exit 0
`,
      { mode: 0o755 }
    );
    const repairAdapter = new AgyAdapter({ binary: spyRepairScript, usePty: false });
    const repairResult = await repairAdapter.runRepair("Repair build", tmpDir, {
      model: "gemini-4-hydrogen-xhigh"
    });
    expect(repairResult.status).toBe("DONE");
    const recordedRepairArgs = fs.readFileSync(repairLogPath, "utf-8");
    expect(recordedRepairArgs).toContain("--mode accept-edits");
    expect(recordedRepairArgs).toContain("--dangerously-skip-permissions");
    expect(recordedRepairArgs).toContain("--model gemini-4-hydrogen-xhigh");
  });

  it("should parse agy models output and deterministically select top reasoning model", () => {
    const rawOutput = `
⠋ Fetching available models...⠙ Fetching available models...
gemini-4-hydrogen-high    Gemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh   Gemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium  Gemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low     Gemini 4 Hydrogen (Low)
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
    const models = parseAgyModelsOutput(rawOutput);
    expect(models).toContain("gemini-4-hydrogen-xhigh");
    expect(models).toContain("claude-opus-4-6-thinking");
    expect(models).toContain("gemini-3.8-flash-high");

    // Top choice should be highest reasoning model: gemini-4-hydrogen-xhigh
    const top = selectTopAgyModel(models);
    expect(top).toBe("gemini-4-hydrogen-xhigh");

    // When xhigh is absent, claude-opus-4-6-thinking should be selected
    const withoutXhigh = models.filter((m) => !m.includes("xhigh"));
    expect(selectTopAgyModel(withoutXhigh)).toBe("claude-opus-4-6-thinking");

    // Override must always be respected
    expect(selectTopAgyModel(models, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});
