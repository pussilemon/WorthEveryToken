import { TaskDigestSchema, type TaskDigest, BacklogSchema, type Backlog } from "../config/schema.js";

export interface AgentExecutionOptions {
  cwd: string;
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
  metrics?: {
    durationMs: number;
    estimatedCostUsd?: number;
  };
}

export interface AgentAdapter {
  readonly name: "claude" | "agy";
  execute(prompt: string, options: AgentExecutionOptions): Promise<ExecutionResult>;
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
