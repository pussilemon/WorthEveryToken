import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgyAdapter } from "../src/adapters/agy-adapter.js";

describe("AgyAdapter", () => {
  let tmpDir: string;
  let hangingScriptPath: string;
  let workingScriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wqb-agy-test-"));

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
echo '<WQB_DIGEST>'
echo '{"files_changed": ["src/util.ts"], "summary": "Added tests", "tests_added": 2, "risks": []}'
echo '</WQB_DIGEST>'
echo '<WQB_EXIT_SIGNAL status="DONE"/>'
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
      silenceWatchdogSec: 1, // 1 second watchdog
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
});
