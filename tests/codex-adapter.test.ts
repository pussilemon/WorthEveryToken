import { describe, it, expect } from "vitest";
import { CodexAdapter, extractTextFromCodexStream } from "../src/adapters/codex-adapter.js";
import { parseExitSignal, parseDigest } from "../src/adapters/agent-adapter.js";

describe("CodexAdapter (Flags, Sandboxing & Rate Limit Classification)", () => {
  it("should configure proper flags for audit (--sandbox read-only, no -p flag for prompt)", async () => {
    // Adapter pointing to echo binary to observe arguments
    const adapter = new CodexAdapter({ binary: "echo" });

    const result = await adapter.runAudit("audit codebase prompt", process.cwd());

    expect(result.output).toContain("--sandbox read-only");
    expect(result.output).not.toContain("-p audit");
    expect(result.output).toContain("audit codebase prompt");
  });

  it("should configure proper flags for task (--sandbox workspace-write --full-auto, positional prompt)", async () => {
    const adapter = new CodexAdapter({ binary: "echo" });

    const result = await adapter.runTask("execute task prompt", process.cwd());

    expect(result.output).toContain("--sandbox workspace-write --full-auto");
    expect(result.output).not.toContain("-p execute");
    expect(result.output).toContain("execute task prompt");
  });

  it("should classify 429 / usage limit in stderr on failure exit code as RATE_LIMITED", async () => {
    // Custom command via bash that exits 1 with a 429 message in stderr
    const adapter = new CodexAdapter({
      binary: "bash"
    });

    const script = `
      echo "Error 429: Rate limit reached. 5-hour quota exhausted. Resets at 14:00." >&2
      exit 1
    `;

    // Passing the bash command
    const result = await adapter.execute(script, {
      cwd: process.cwd(),
      timeoutSec: 5
    });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.exitCode).toBe(429);
    expect(result.rateLimitType).toBe("5h");
  });

  it("should classify weekly limit in stderr as RATE_LIMITED weekly", async () => {
    const adapter = new CodexAdapter({
      binary: "bash"
    });

    const script = `
      echo "API Error: Weekly usage limit exceeded. Resets next Monday." >&2
      exit 1
    `;

    const result = await adapter.execute(script, {
      cwd: process.cwd(),
      timeoutSec: 5
    });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.exitCode).toBe(429);
    expect(result.rateLimitType).toBe("weekly");
  });

  it("should unwrap text, escaped exit signal, and nested digest from NDJSON stream", () => {
    const ndjson = [
      JSON.stringify({ type: "session.created", id: "sess_123" }),
      JSON.stringify({
        type: "item.created",
        item: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: 'Applied the requested security fix.\n<WET_EXIT_SIGNAL status="DONE"/>\n<WET_DIGEST>{"files_changed":["src/auth.ts"],"summary":"Patched timing attack in token check","tests_added":2,"risks":[]}</WET_DIGEST>'
            }
          ]
        }
      }),
      JSON.stringify({ type: "response.completed" })
    ].join("\n");

    const text = extractTextFromCodexStream(ndjson);
    expect(text).toContain('<WET_EXIT_SIGNAL status="DONE"/>');
    expect(text).toContain("<WET_DIGEST>");
    expect(text).toContain("src/auth.ts");

    const signal = parseExitSignal(text);
    expect(signal.status).toBe("DONE");

    const digest = parseDigest(text);
    expect(digest?.files_changed).toEqual(["src/auth.ts"]);
    expect(digest?.summary).toBe("Patched timing attack in token check");
    expect(digest?.tests_added).toBe(2);
  });
});
