import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import {
  extractTextFromClaudeStream,
  parseExitSignal,
  parseDigest,
  parseUsageText
} from "../src/adapters/agent-adapter.js";
import { ClaudeAdapter } from "../src/adapters/claude-adapter.js";

describe("ClaudeAdapter stream-json Extraction & Usage Probe", () => {
  it("should extract text and total_cost_usd from real NDJSON multi-line payload", () => {
    const ndjsonPayload = [
      JSON.stringify({ type: "system", message: "Starting session" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "I have investigated the issue and applied the fix.\n<WET_DIGEST>\n{\"files_changed\": [\"src/auth.ts\"], \"summary\": \"Fixed session timeout\", \"tests_added\": 1, \"risks\": []}\n</WET_DIGEST>"
            }
          ]
        }
      }),
      JSON.stringify({
        type: "result",
        result: "<WET_EXIT_SIGNAL status=\"DONE\"/>",
        total_cost_usd: 0.042
      })
    ].join("\n");

    const extracted = extractTextFromClaudeStream(ndjsonPayload);

    expect(extracted.costUsd).toBe(0.042);
    expect(extracted.text).toContain("<WET_DIGEST>");
    expect(extracted.text).toContain("<WET_EXIT_SIGNAL status=\"DONE\"/>");

    const signal = parseExitSignal(extracted.text);
    expect(signal.status).toBe("DONE");

    const digest = parseDigest(extracted.text);
    expect(digest).not.toBeNull();
    expect(digest?.files_changed).toEqual(["src/auth.ts"]);
    expect(digest?.tests_added).toBe(1);
  });

  it("should handle non-NDJSON plain text as fallback", () => {
    const rawText = "Just simple output\n<WET_EXIT_SIGNAL status=\"DONE\"/>";
    const extracted = extractTextFromClaudeStream(rawText);

    expect(extracted.text).toBe(rawText);
    expect(extracted.costUsd).toBeUndefined();
    expect(parseExitSignal(extracted.text).status).toBe("DONE");
  });

  it("should capture entire multi-chunk PTY /usage output via settle debounce without truncating data", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wet-claude-probe-"));
    const mockPtyScript = path.join(tmpDir, "mock-claude-pty.sh");

    // Script emits chunk 1 (5-hour header), waits, then emits chunk 2 (percentages & resets)
    fs.writeFileSync(
      mockPtyScript,
      `#!/bin/bash
echo "Current Session Limits:"
echo "5-hour Window:"
sleep 0.2
echo "  Usage: 42% (Resets in 2 hours)"
sleep 0.2
echo "Weekly Limit:"
echo "  Usage: 68% (Resets next Monday at 08:00)"
# Wait for settle debounce to trigger /exit
read -t 5 line || true
exit 0
`,
      { mode: 0o755 }
    );

    try {
      const adapter = new ClaudeAdapter({ binary: mockPtyScript });
      const usage = await adapter.probeUsage();

      expect(usage).toBeDefined();
      expect(usage.window5hUsedPct).toBe(42);
      expect(usage.weeklyUsedPct).toBe(68);
      expect(usage.buckets.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should parse multi-line usage text into quota buckets correctly", () => {
    const sampleUsage = `
      5-hour limit: 35% used. Resets at 18:30.
      Weekly limit: 75% used. Resets on Monday.
    `;
    const parsed = parseUsageText(sampleUsage);
    expect(parsed.window5hUsedPct).toBe(35);
    expect(parsed.weeklyUsedPct).toBe(75);
  });
});
