import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/core/circuit-breaker.js";
import { parseExitSignal, parseDigest } from "../src/adapters/agent-adapter.js";

describe("CircuitBreaker", () => {
  it("should transition from CLOSED to OPEN after max consecutive failures", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.isOpen()).toBe(false);

    cb.recordFailure("T-001", "error 1");
    expect(cb.getState()).toBe("CLOSED");

    cb.recordFailure("T-002", "error 2");
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordFailure("T-003", "error 3");
    expect(cb.getState()).toBe("OPEN");
    expect(cb.isOpen()).toBe(true);
    expect(cb.getTripReason()).toContain("Exceeded 3 consecutive failures");
  });

  it("should trip immediately if identical error hash occurs twice consecutively on same task", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    const identicalError = "TypeError: Cannot read properties of undefined (reading 'foo') at line 42";

    cb.recordFailure("T-001", identicalError);
    expect(cb.isOpen()).toBe(false);

    cb.recordFailure("T-001", identicalError);
    expect(cb.isOpen()).toBe(true);
    expect(cb.getTripReason()).toContain("Identical error hash repeated twice consecutively");
  });

  it("should reset state upon recorded success", () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    cb.recordFailure("T-001", "error 1");
    cb.recordFailure("T-002", "error 2");
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
  });
});

describe("Dual-Condition Exit Gate & Signal Parsing", () => {
  it("should recognize DONE signal", () => {
    const output = "Work completed.\n<WQB_EXIT_SIGNAL status=\"DONE\"/>";
    const signal = parseExitSignal(output);
    expect(signal.status).toBe("DONE");
  });

  it("should recognize BLOCKED signal with reason", () => {
    const output = "Cannot fix.\n<WQB_EXIT_SIGNAL status=\"BLOCKED\" reason=\"Legacy external API deprecated\"/>";
    const signal = parseExitSignal(output);
    expect(signal.status).toBe("BLOCKED");
    expect(signal.reason).toBe("Legacy external API deprecated");
  });

  it("should return null signal when marker is missing (exit 0 without marker must fail)", () => {
    const output = "I finished the changes but didn't include the required exit protocol XML tag.";
    const signal = parseExitSignal(output);
    expect(signal.status).toBeNull();
  });

  it("should parse valid WQB_DIGEST block", () => {
    const output = `
<WQB_DIGEST>
{
  "files_changed": ["src/auth.ts"],
  "summary": "Fixed edge case in token expiration",
  "tests_added": 1,
  "risks": []
}
</WQB_DIGEST>
<WQB_EXIT_SIGNAL status="DONE"/>
    `;
    const digest = parseDigest(output);
    expect(digest).not.toBeNull();
    expect(digest?.files_changed).toEqual(["src/auth.ts"]);
    expect(digest?.tests_added).toBe(1);
  });
});
