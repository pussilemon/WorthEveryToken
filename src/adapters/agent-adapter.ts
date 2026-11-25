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

export function parseExitSignal(output: string): { status: "DONE" | "BLOCKED" | null; reason?: string } {
  const doneMatch = output.match(/<WQB_EXIT_SIGNAL\s+status=["']DONE["']\s*\/?>/i);
  if (doneMatch) {
    return { status: "DONE" };
  }

  const blockedMatch = output.match(/<WQB_EXIT_SIGNAL\s+status=["']BLOCKED["'](?:\s+reason=["']([^"']*)["'])?\s*\/?>/i);
  if (blockedMatch) {
    return { status: "BLOCKED", reason: blockedMatch[1] ?? "Unspecified reason" };
  }

  return { status: null };
}

export function parseDigest(output: string): TaskDigest | null {
  const match = output.match(/<WQB_DIGEST>([\s\S]*?)<\/WQB_DIGEST>/i);
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
  const match = output.match(/<WQB_BACKLOG_JSON>([\s\S]*?)<\/WQB_BACKLOG_JSON>/i);
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
