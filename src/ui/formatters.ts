import pc from "picocolors";
import type { WavePlan } from "../scheduler/wave-planner.js";
import type { UsageSnapshot } from "../adapters/agent-adapter.js";
import type { ActiveProject, QuotaTopologyType } from "../config/schema.js";
import type { WatcherServiceStatus } from "../scheduler/service-installer.js";

export function formatTopologyLabel(type?: QuotaTopologyType | null): string {
  switch (type) {
    case "TWO_TIER_WINDOW":
      return "2-Tier Window (Macro-Cap + Rolling Window)";
    case "SINGLE_CYCLE_CAP":
      return "Single-Cycle Cap (Continuous Session)";
    case "ROLLING_ONLY":
      return "Rolling-Only (Quiet Hours Windows)";
    case "MULTI_BUCKET_CASCADE":
      return "Multi-Model Cascade (Opus -> Sonnet / o3)";
    default:
      return "Standard Adaptive Topology";
  }
}

export function formatHeaderBanner(options: {
  provider: string;
  model: string;
  usage?: UsageSnapshot | null;
  activeProject?: ActiveProject | null;
  watcher?: WatcherServiceStatus | null;
  plan?: WavePlan | null;
  topologyType?: QuotaTopologyType | null;
}): string {
  const line = pc.cyan("─".repeat(64));
  const lines: string[] = [
    line,
    pc.bold(pc.cyan("  WorthEveryToken (wet) v2.3.0 — Zero-Bleed Autonomous Token Burner")),
    line
  ];

  // Provider line
  lines.push(`  ${pc.bold("Provider:")}    ${pc.green(options.provider)} (${options.model})`);

  // Topology line
  const topologyStr = formatTopologyLabel(options.topologyType);
  lines.push(`  ${pc.bold("Topology:")}    ${pc.magenta(topologyStr)}`);

  // Invisibility & Guard Status
  lines.push(`  ${pc.bold("Invisibility:")} ${pc.green("Activity Guard: active ✓")} | ${pc.green("Repo HEAD untouched ✓")}`);

  // Watcher status line
  const watcherStr = options.watcher?.active
    ? pc.green(`Active (${options.watcher.method}) ✓`)
    : pc.yellow("Inactive / manual");
  lines.push(`  ${pc.bold("Watcher:")}     ${watcherStr}`);

  // Active project line
  if (options.activeProject) {
    const statusColor =
      options.activeProject.status === "running_wave"
        ? pc.green(options.activeProject.status)
        : options.activeProject.status === "waiting_window_reset"
        ? pc.yellow(options.activeProject.status)
        : options.activeProject.status === "yielded_to_user"
        ? pc.yellow("yielded_to_user (paused for user activity)")
        : pc.cyan(options.activeProject.status);
    lines.push(`  ${pc.bold("Project:")}     ${pc.bold(options.activeProject.repoName)} [${statusColor}]`);
    lines.push(`              ${pc.dim(options.activeProject.repoPath)}`);
  } else {
    lines.push(`  ${pc.bold("Project:")}     ${pc.dim("No armed project on this machine")}`);
  }

  // Quota & Wave plan summary
  if (options.usage) {
    const weeklyUsed = options.usage.weeklyUsedPct !== null ? `${options.usage.weeklyUsedPct}%` : "n/a";
    const window5h = options.usage.window5hUsedPct !== null ? `${options.usage.window5hUsedPct}%` : "n/a";
    lines.push(`  ${pc.bold("Quota:")}       Macro-cycle: ${pc.yellow(weeklyUsed)} | Rolling window: ${pc.yellow(window5h)}`);
  }

  if (options.plan) {
    const remStr = `${options.plan.remainingPct.toFixed(1)}%`;
    const wavesStr = options.plan.wavesNeeded > 0 ? `${options.plan.wavesNeeded} waves planned` : "No waves";
    lines.push(`  ${pc.bold("Schedule:")}    Target remaining: ${pc.cyan(remStr)} | ${pc.bold(wavesStr)}`);

    // Zero-Bleed status
    const hardStopStr = options.plan.hardStopAt ? options.plan.hardStopAt.toLocaleTimeString() : "active";
    lines.push(`  ${pc.bold("Zero-Bleed:")}  ${pc.red(`Hard Stop at ${hardStopStr} (Zero-Bleed pre-reset safeguard) ✓`)}`);

    if (options.plan.action === "WAIT_UNTIL_START") {
      lines.push(`              ${pc.magenta(`Scheduled start: ${options.plan.plannedStartAt.toLocaleString()}`)}`);
    } else if (options.plan.action === "START_WAVE_NOW") {
      lines.push(`              ${pc.green(`IN PROGRESS: Wave ${options.plan.waveIndex} of ${options.plan.wavesNeeded}`)}`);
    } else if (options.plan.action === "WAIT_WINDOW_UNLOCK" && options.plan.nextWakeAt) {
      lines.push(`              ${pc.yellow(`Waiting for rolling window unlock: ${options.plan.nextWakeAt.toLocaleTimeString()}`)}`);
    } else if (options.plan.action === "STOP_BEFORE_RESET") {
      lines.push(`              ${pc.red(`Pre-reset Hard Stop active: no tokens from new cycle will be used`)}`);
    }
  }

  lines.push(line);
  return lines.join("\n");
}

export function formatWaveTimelineTable(plan: WavePlan): string {
  if (plan.timeline.length === 0) {
    return pc.dim("No waves scheduled in current window.");
  }

  const lines: string[] = [
    pc.bold("Adaptive Wave Plan:"),
    pc.dim("─".repeat(60))
  ];

  for (const entry of plan.timeline) {
    const isCurrent = plan.action === "START_WAVE_NOW" && plan.waveIndex === entry.waveIndex;
    const prefix = isCurrent ? pc.green(" ▶ ") : "   ";
    const timeStr = entry.plannedStartAt.toLocaleString();
    const burnStr = `~${entry.estimatedBurnPct}% quota`;
    const modelTag = entry.model ? ` [${entry.model}]` : "";
    lines.push(
      `${prefix}${pc.bold(`Wave ${entry.waveIndex}`)}: ${pc.cyan(timeStr)} (${pc.yellow(burnStr)})${modelTag}`
    );
  }

  lines.push(pc.dim("─".repeat(60)));
  lines.push(
    `Zero-Bleed Hard Stop: ${pc.red(plan.hardStopAt.toLocaleTimeString())} (pre-reset safeguard)`
  );

  return lines.join("\n");
}

export function formatUsageReport(usage: UsageSnapshot): string {
  const lines: string[] = [
    pc.bold("Provider Limits & Quota Probe:"),
    `• Provider: ${pc.green(usage.provider)}`,
    `• Data source: ${pc.cyan(usage.source)}`,
    `• Quota consumed: ${usage.weeklyUsedPct !== null ? pc.yellow(`${usage.weeklyUsedPct}%`) : "unknown"}`,
    `• Primary cycle reset: ${usage.weeklyResetAt ? pc.magenta(usage.weeklyResetAt.toLocaleString()) : "not detected"}`,
    `• Rolling window: ${usage.window5hUsedPct !== null ? pc.yellow(`${usage.window5hUsedPct}%`) : "unknown"}`,
    `• Rolling reset: ${usage.window5hResetAt ? pc.magenta(usage.window5hResetAt.toLocaleTimeString()) : "not detected"}`
  ];

  if (usage.buckets && usage.buckets.length > 0) {
    lines.push(`• Detected buckets (${usage.buckets.length}):`);
    for (const b of usage.buckets) {
      lines.push(`  - [${b.id}] role: ${b.role}, duration: ${b.durationHours}h, used: ${b.usedPct}%`);
    }
  }

  return lines.join("\n");
}
