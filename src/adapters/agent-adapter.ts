import {
  TaskDigestSchema,
  type TaskDigest,
  BacklogSchema,
  type Backlog,
  type ProviderId,
  type WetGlobalConfig
} from "../config/schema.js";

export interface AgentExecutionOptions {
  cwd?: string;
  timeoutSec?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  allowedTools?: string;
  onChunk?: (chunk: string) => void;
}

export interface ExecutionResult {
  exitCode: number;
  status: "DONE" | "BLOCKED" | "FAILED" | "RATE_LIMITED";
  digest: TaskDigest | null;
  output: string;
  error?: string;
  blockedReason?: string;
  rateLimitReset?: string;
  rateLimitType?: "5h" | "weekly";
  metrics?: {
    durationMs: number;
    estimatedCostUsd?: number;
  };
}

export interface UsageSnapshot {
  provider: ProviderId;
  probedAt: Date;
  source: "cli_probe" | "rate_limit_header" | "local_logs" | "fallback_manual";
  weeklyUsedPct: number | null;
  weeklyResetAt: Date | null;
  window5hUsedPct: number | null;
  window5hResetAt: Date | null;
  detectedModel?: string | null;
  rawSnippet?: string;
}

export interface AgentAdapter {
  readonly provider: ProviderId;
  checkInstalled(): Promise<{ available: boolean; version?: string; binaryPath?: string }>;
  getTopModelProfile(config: WetGlobalConfig): { model: string; effort?: string; extraFlags: string[] };
  probeUsage(): Promise<UsageSnapshot>;
  runAudit(prompt: string, workdir: string, options?: AgentExecutionOptions): Promise<ExecutionResult>;
  runTask(prompt: string, workdir: string, options?: AgentExecutionOptions): Promise<ExecutionResult>;
  runRepair(prompt: string, workdir: string, options?: AgentExecutionOptions): Promise<ExecutionResult>;
}

export function extractTextFromClaudeStream(rawOutput: string): { text: string; costUsd?: number } {
  const lines = rawOutput.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let parsedJsonLinesCount = 0;
  let resultText = "";
  let assistantText = "";
  let costUsd: number | undefined;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      parsedJsonLinesCount++;

      if (entry.type === "result") {
        if (typeof entry.result === "string" && entry.result.trim().length > 0) {
          resultText = entry.result;
        }
        if (typeof entry.total_cost_usd === "number") {
          costUsd = entry.total_cost_usd;
        }
      } else if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            assistantText += block.text + "\n";
          }
        }
      }
    } catch {
      // Not a JSON line, continue
    }
  }

  if (parsedJsonLinesCount === 0) {
    return { text: rawOutput };
  }

  let finalText = "";
  const trimmedAssistant = assistantText.trim();
  const trimmedResult = resultText.trim();

  if (trimmedAssistant && trimmedResult) {
    if (trimmedAssistant.includes(trimmedResult)) {
      finalText = trimmedAssistant;
    } else {
      finalText = trimmedAssistant + "\n" + trimmedResult;
    }
  } else if (trimmedAssistant) {
    finalText = trimmedAssistant;
  } else if (trimmedResult) {
    finalText = trimmedResult;
  } else {
    finalText = rawOutput;
  }

  return { text: finalText, costUsd };
}

export function parseExitSignal(output: string): { status: "DONE" | "BLOCKED" | null; reason?: string } {
  const doneMatch = output.match(/<WET_EXIT_SIGNAL\s+status=["']DONE["']\s*\/?>/i);
  if (doneMatch) {
    return { status: "DONE" };
  }

  const blockedMatch = output.match(/<WET_EXIT_SIGNAL\s+status=["']BLOCKED["'](?:\s+reason=["']([^"']*)["'])?\s*\/?>/i);
  if (blockedMatch) {
    return { status: "BLOCKED", reason: blockedMatch[1] ?? "Unspecified reason" };
  }

  return { status: null };
}

export function parseDigest(output: string): TaskDigest | null {
  const match = output.match(/<WET_DIGEST>([\s\S]*?)<\/WET_DIGEST>/i);
  if (!match || !match[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1].trim());
    const valid = TaskDigestSchema.safeParse(parsed);
    if (valid.success) {
      return valid.data;
    }
  } catch {
    // JSON parse error
  }

  return null;
}

export function parseBacklogJson(output: string): Backlog | null {
  const match = output.match(/<WET_BACKLOG_JSON>([\s\S]*?)<\/WET_BACKLOG_JSON>/i);
  if (!match || !match[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1].trim());
    const valid = BacklogSchema.safeParse(parsed);
    if (valid.success) {
      return valid.data;
    }
  } catch {
    // Ignore error
  }

  return null;
}

export function parseFixPlanMd(output: string): string | null {
  const match = output.match(/<WET_FIX_PLAN_MD>([\s\S]*?)<\/WET_FIX_PLAN_MD>/i);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].trim();
}

export function parseUsageText(text: string): {
  weeklyUsedPct: number | null;
  weeklyResetAt: Date | null;
  window5hUsedPct: number | null;
  window5hResetAt: Date | null;
} {
  let weeklyUsedPct: number | null = null;
  let weeklyResetAt: Date | null = null;
  let window5hUsedPct: number | null = null;
  let window5hResetAt: Date | null = null;

  // Percentage patterns: e.g. "Weekly limit: 73% used" or "weekly: 73%"
  const weeklyPctMatch = text.match(/weekly(?:\s+limit)?[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (weeklyPctMatch?.[1]) {
    weeklyUsedPct = parseFloat(weeklyPctMatch[1]);
  }

  const window5hPctMatch = text.match(/(?:5-hour|5h|session)(?:\s+limit)?[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  if (window5hPctMatch?.[1]) {
    window5hUsedPct = parseFloat(window5hPctMatch[1]);
  }

  // Relative resets: e.g. "Resets in 2h 15m" or "resets in 45m"
  const relResetMatch = text.match(/resets\s+in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (relResetMatch) {
    const hours = parseInt(relResetMatch[1] ?? "0", 10);
    const mins = parseInt(relResetMatch[2] ?? "0", 10);
    if (hours > 0 || mins > 0) {
      const ms = (hours * 60 + mins) * 60 * 1000;
      window5hResetAt = new Date(Date.now() + ms);
    }
  }

  // Day reset patterns: e.g. "Resets Mon 8:00 AM" or "Resets Monday 08:00"
  const dayResetMatch = text.match(/resets\s+(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (dayResetMatch) {
    const dayStr = dayResetMatch[1]?.slice(0, 3).toLowerCase();
    let hour = parseInt(dayResetMatch[2] ?? "0", 10);
    const min = parseInt(dayResetMatch[3] ?? "0", 10);
    const meridiem = dayResetMatch[4]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    const daysMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = daysMap[dayStr ?? "mon"] ?? 1;

    const targetDate = new Date();
    targetDate.setHours(hour, min, 0, 0);
    const currentDay = targetDate.getDay();
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    if (daysToAdd === 0 && targetDate.getTime() <= Date.now()) {
      daysToAdd = 7;
    }
    targetDate.setDate(targetDate.getDate() + daysToAdd);
    weeklyResetAt = targetDate;
  }

  return { weeklyUsedPct, weeklyResetAt, window5hUsedPct, window5hResetAt };
}
