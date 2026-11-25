import pc from "picocolors";
import type { WavePlan } from "../scheduler/wave-planner.js";
import type { UsageSnapshot } from "../adapters/agent-adapter.js";
import type { ActiveProject } from "../config/schema.js";
import type { WatcherServiceStatus } from "../scheduler/service-installer.js";

export function formatHeaderBanner(options: {
  provider: string;
  model: string;
  usage?: UsageSnapshot | null;
  activeProject?: ActiveProject | null;
  watcher?: WatcherServiceStatus | null;
  plan?: WavePlan | null;
}): string {
  const line = pc.cyan("─".repeat(60));
  const lines: string[] = [
    line,
    pc.bold(pc.cyan("  WorthEveryToken (wet) v2 — Autonomous Multi-Cycle Token Burner")),
    line
  ];

  // Provider line
  lines.push(`  ${pc.bold("Provider:")}    ${pc.green(options.provider)} (${options.model})`);

  // Watcher status line
  const watcherStr = options.watcher?.active
    ? pc.green(`Attivo (${options.watcher.method}) ✓`)
    : pc.yellow("Non attivo / manuale");
  lines.push(`  ${pc.bold("Watcher:")}     ${watcherStr}`);

  // Active project line
  if (options.activeProject) {
    const statusColor =
      options.activeProject.status === "running_wave"
        ? pc.green(options.activeProject.status)
        : options.activeProject.status === "waiting_window_reset"
        ? pc.yellow(options.activeProject.status)
        : pc.cyan(options.activeProject.status);
    lines.push(`  ${pc.bold("Progetto:")}    ${pc.bold(options.activeProject.repoName)} [${statusColor}]`);
    lines.push(`              ${pc.dim(options.activeProject.repoPath)}`);
  } else {
    lines.push(`  ${pc.bold("Progetto:")}    ${pc.dim("Nessun progetto armato sulla macchina")}`);
  }

  // Quota & Wave plan summary
  if (options.usage) {
    const weeklyUsed = options.usage.weeklyUsedPct !== null ? `${options.usage.weeklyUsedPct}%` : "n/d";
    const window5h = options.usage.window5hUsedPct !== null ? `${options.usage.window5hUsedPct}%` : "n/d";
    lines.push(`  ${pc.bold("Quota:")}       Settimanale usata: ${pc.yellow(weeklyUsed)} | Finestra 5h: ${pc.yellow(window5h)}`);
  }

  if (options.plan) {
    const remStr = `${options.plan.remainingPct.toFixed(1)}%`;
    const wavesStr = `${options.plan.wavesNeeded} ondate da 5h`;
    lines.push(`  ${pc.bold("Pianif.:")}     Residuo target: ${pc.cyan(remStr)} | Stima: ${pc.bold(wavesStr)}`);
    if (options.plan.action === "WAIT_UNTIL_START") {
      lines.push(`              ${pc.magenta(`Avvio previsto: ${options.plan.plannedStartAt.toLocaleString()}`)}`);
    } else if (options.plan.action === "START_WAVE_NOW") {
      lines.push(`              ${pc.green(`IN CORSO: Ondata ${options.plan.waveIndex} di ${options.plan.wavesNeeded}`)}`);
    } else if (options.plan.action === "WAIT_WINDOW_UNLOCK" && options.plan.nextWakeAt) {
      lines.push(`              ${pc.yellow(`Attesa sblocco 5h: ${options.plan.nextWakeAt.toLocaleTimeString()}`)}`);
    } else if (options.plan.action === "STOP_BEFORE_RESET") {
      lines.push(`              ${pc.red(`Hard Stop pre-reset attivo fino al nuovo ciclo`)}`);
    }
  }

  lines.push(line);
  return lines.join("\n");
}

export function formatWaveTimelineTable(plan: WavePlan): string {
  if (plan.timeline.length === 0) {
    return pc.dim("Nessuna ondata pianificata nella finestra attuale.");
  }

  const lines: string[] = [
    pc.bold("Piano Ondate Calcolato:"),
    pc.dim("─".repeat(55))
  ];

  for (const entry of plan.timeline) {
    const isCurrent = plan.action === "START_WAVE_NOW" && plan.waveIndex === entry.waveIndex;
    const prefix = isCurrent ? pc.green(" ▶ ") : "   ";
    const timeStr = entry.plannedStartAt.toLocaleString();
    const burnStr = `~${entry.estimatedBurnPct}% quota`;
    lines.push(
      `${prefix}${pc.bold(`Ondata ${entry.waveIndex}`)}: ${pc.cyan(timeStr)} (${pc.yellow(burnStr)})`
    );
  }

  lines.push(pc.dim("─".repeat(55)));
  lines.push(
    `Hard Stop anti-sconfinamento: ${pc.red(plan.hardStopAt.toLocaleTimeString())} (10 min prima del reset)`
  );

  return lines.join("\n");
}

export function formatUsageReport(usage: UsageSnapshot): string {
  const lines: string[] = [
    pc.bold("Rilevamento Limiti & Quota Provider:"),
    `• Provider: ${pc.green(usage.provider)}`,
    `• Fonte dati: ${pc.cyan(usage.source)}`,
    `• Quota settimanale consumata: ${usage.weeklyUsedPct !== null ? pc.yellow(`${usage.weeklyUsedPct}%`) : "sconosciuta"}`,
    `• Reset settimanale: ${usage.weeklyResetAt ? pc.magenta(usage.weeklyResetAt.toLocaleString()) : "non rilevato"}`,
    `• Finestra 5 ore consumata: ${usage.window5hUsedPct !== null ? pc.yellow(`${usage.window5hUsedPct}%`) : "sconosciuta"}`,
    `• Reset finestra 5 ore: ${usage.window5hResetAt ? pc.magenta(usage.window5hResetAt.toLocaleTimeString()) : "non rilevato"}`
  ];
  return lines.join("\n");
}
