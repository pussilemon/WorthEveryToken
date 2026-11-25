import pc from "picocolors";
import type { WavePlan } from "../scheduler/wave-planner.js";
import type { UsageSnapshot } from "../adapters/agent-adapter.js";
import type { ActiveProject, QuotaTopologyType } from "../config/schema.js";
import type { WatcherServiceStatus } from "../scheduler/service-installer.js";

export function formatTopologyLabel(type?: QuotaTopologyType | null): string {
  switch (type) {
    case "TWO_TIER_WINDOW":
      return "2-Tier Window (Macro-Cap + Micro-Finestra)";
    case "SINGLE_CYCLE_CAP":
      return "Single-Cycle Cap (Sessione Continua)";
    case "ROLLING_ONLY":
      return "Rolling-Only (Slot Notturni Quiet Hours)";
    case "MULTI_BUCKET_CASCADE":
      return "Multi-Model Cascade (Opus -> Sonnet / o3)";
    default:
      return "Topologia Adattiva Standard";
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
    pc.bold(pc.cyan("  WorthEveryToken (wet) v2.1 — Zero-Bleed Autonomous Token Burner")),
    line
  ];

  // Provider line
  lines.push(`  ${pc.bold("Provider:")}    ${pc.green(options.provider)} (${options.model})`);

  // Topology line
  const topologyStr = formatTopologyLabel(options.topologyType);
  lines.push(`  ${pc.bold("Topologia:")}   ${pc.magenta(topologyStr)}`);

  // Invisibility & Guard Status
  lines.push(`  ${pc.bold("Invisibilità:")} ${pc.green("Activity Guard: attivo ✓")} | ${pc.green("Repo HEAD intoccato ✓")}`);

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
        : options.activeProject.status === "yielded_to_user"
        ? pc.yellow("yielded_to_user (pausa attività umana)")
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
    lines.push(`  ${pc.bold("Quota:")}       Uso macro-ciclo: ${pc.yellow(weeklyUsed)} | Micro-finestra: ${pc.yellow(window5h)}`);
  }

  if (options.plan) {
    const remStr = `${options.plan.remainingPct.toFixed(1)}%`;
    const wavesStr = options.plan.wavesNeeded > 0 ? `${options.plan.wavesNeeded} ondate pianificate` : "Nessuna ondata";
    lines.push(`  ${pc.bold("Pianif.:")}     Residuo target: ${pc.cyan(remStr)} | ${pc.bold(wavesStr)}`);

    // Zero-Bleed status
    const hardStopStr = options.plan.hardStopAt ? options.plan.hardStopAt.toLocaleTimeString() : "attivo";
    lines.push(`  ${pc.bold("Zero-Bleed:")}  ${pc.red(`Hard Stop alle ${hardStopStr} (20m pre-reset) ✓`)}`);

    if (options.plan.action === "WAIT_UNTIL_START") {
      lines.push(`              ${pc.magenta(`Avvio previsto: ${options.plan.plannedStartAt.toLocaleString()}`)}`);
    } else if (options.plan.action === "START_WAVE_NOW") {
      lines.push(`              ${pc.green(`IN CORSO: Ondata ${options.plan.waveIndex} di ${options.plan.wavesNeeded}`)}`);
    } else if (options.plan.action === "WAIT_WINDOW_UNLOCK" && options.plan.nextWakeAt) {
      lines.push(`              ${pc.yellow(`Attesa sblocco micro-finestra: ${options.plan.nextWakeAt.toLocaleTimeString()}`)}`);
    } else if (options.plan.action === "STOP_BEFORE_RESET") {
      lines.push(`              ${pc.red(`Hard Stop pre-reset attivo: nessun token del nuovo ciclo verrà toccato`)}`);
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
    pc.bold("Piano Ondate Adattivo:"),
    pc.dim("─".repeat(60))
  ];

  for (const entry of plan.timeline) {
    const isCurrent = plan.action === "START_WAVE_NOW" && plan.waveIndex === entry.waveIndex;
    const prefix = isCurrent ? pc.green(" ▶ ") : "   ";
    const timeStr = entry.plannedStartAt.toLocaleString();
    const burnStr = `~${entry.estimatedBurnPct}% quota`;
    const modelTag = entry.model ? ` [${entry.model}]` : "";
    lines.push(
      `${prefix}${pc.bold(`Ondata ${entry.waveIndex}`)}: ${pc.cyan(timeStr)} (${pc.yellow(burnStr)})${modelTag}`
    );
  }

  lines.push(pc.dim("─".repeat(60)));
  lines.push(
    `Zero-Bleed Hard Stop: ${pc.red(plan.hardStopAt.toLocaleTimeString())} (20 min prima del reset)`
  );

  return lines.join("\n");
}

export function formatUsageReport(usage: UsageSnapshot): string {
  const lines: string[] = [
    pc.bold("Rilevamento Limiti & Quota Provider:"),
    `• Provider: ${pc.green(usage.provider)}`,
    `• Fonte dati: ${pc.cyan(usage.source)}`,
    `• Quota consumata: ${usage.weeklyUsedPct !== null ? pc.yellow(`${usage.weeklyUsedPct}%`) : "sconosciuta"}`,
    `• Reset ciclo principale: ${usage.weeklyResetAt ? pc.magenta(usage.weeklyResetAt.toLocaleString()) : "non rilevato"}`,
    `• Micro-finestra rolling: ${usage.window5hUsedPct !== null ? pc.yellow(`${usage.window5hUsedPct}%`) : "sconosciuta"}`,
    `• Reset micro-finestra: ${usage.window5hResetAt ? pc.magenta(usage.window5hResetAt.toLocaleTimeString()) : "non rilevato"}`
  ];

  if (usage.buckets && usage.buckets.length > 0) {
    lines.push(`• Bucket rilevati (${usage.buckets.length}):`);
    for (const b of usage.buckets) {
      lines.push(`  - [${b.id}] role: ${b.role}, durata: ${b.durationHours}h, usato: ${b.usedPct}%`);
    }
  }

  return lines.join("\n");
}
