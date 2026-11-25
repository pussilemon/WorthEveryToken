import { describe, it, expect } from "vitest";
import { getAdapter } from "../src/adapters/registry.js";
import { parseUsageText } from "../src/adapters/agent-adapter.js";
import type { ProviderId } from "../src/config/schema.js";

describe("Universal Adapter Registry & Usage Parsing", () => {
  const providers: ProviderId[] = ["claude", "codex", "agy", "gemini", "custom"];

  it.each(providers)("instantiates adapter for provider '%s' with universal interface", (provider) => {
    const adapter = getAdapter(provider);

    expect(adapter.provider).toBe(provider);
    expect(typeof adapter.checkInstalled).toBe("function");
    expect(typeof adapter.getTopModelProfile).toBe("function");
    expect(typeof adapter.probeUsage).toBe("function");
    expect(typeof adapter.runAudit).toBe("function");
    expect(typeof adapter.runTask).toBe("function");
    expect(typeof adapter.runRepair).toBe("function");
  });

  it("parses realistic CLI usage text with percentages and reset timestamps", () => {
    const snippet = `
      Claude Code Usage Status:
      5-hour limit: 45% used · Resets in 2h 15m
      Weekly limit: 73% used · Resets Mon 8:00 AM
    `;

    const parsed = parseUsageText(snippet);

    expect(parsed.weeklyUsedPct).toBe(73);
    expect(parsed.window5hUsedPct).toBe(45);
    expect(parsed.window5hResetAt).toBeInstanceOf(Date);
    expect(parsed.weeklyResetAt).toBeInstanceOf(Date);

    // Verify window5hResetAt is in the future (~2h 15m from now)
    const diffMs = parsed.window5hResetAt!.getTime() - Date.now();
    const diffHours = diffMs / 3600_000;
    expect(diffHours).toBeGreaterThan(2.1);
    expect(diffHours).toBeLessThan(2.4);

    // Verify weeklyResetAt day of week is Monday (1)
    expect(parsed.weeklyResetAt!.getDay()).toBe(1);
  });

  it("handles relative time with only minutes", () => {
    const snippet = "5h limit: 95% used · Resets in 45m";
    const parsed = parseUsageText(snippet);

    expect(parsed.window5hUsedPct).toBe(95);
    expect(parsed.window5hResetAt).toBeInstanceOf(Date);

    const diffMinutes = (parsed.window5hResetAt!.getTime() - Date.now()) / 60_000;
    expect(diffMinutes).toBeGreaterThan(43);
    expect(diffMinutes).toBeLessThan(47);
  });

  it("gracefully returns nulls for unparseable snippet without throwing", () => {
    const snippet = "Random CLI stdout with no usage information";
    const parsed = parseUsageText(snippet);

    expect(parsed.weeklyUsedPct).toBeNull();
    expect(parsed.weeklyResetAt).toBeNull();
    expect(parsed.window5hUsedPct).toBeNull();
    expect(parsed.window5hResetAt).toBeNull();
  });
});
