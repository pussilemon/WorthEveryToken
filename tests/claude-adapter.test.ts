import { describe, it, expect } from "vitest";
import { extractTextFromClaudeStream, parseExitSignal, parseDigest } from "../src/adapters/agent-adapter.js";

describe("ClaudeAdapter stream-json Extraction", () => {
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
});
