import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  hasGlobalConfig,
  loadGlobalConfig,
  saveGlobalConfig,
  loadMachineState,
  armProject,
  disarmProject
} from "../config/global-store.js";
import { type ProviderId, type WetGlobalConfig } from "../config/schema.js";
import { getAdapter } from "../adapters/registry.js";
import type { UsageSnapshot } from "../adapters/agent-adapter.js";
import { CalibrationEngine } from "../scheduler/calibration-engine.js";
import { computeExecutionPlan } from "../scheduler/wave-planner.js";
import { classifyTopology } from "../scheduler/quota-topology.js";
import {
  installBackgroundWatcher,
  uninstallBackgroundWatcher,
  getWatcherStatus
} from "../scheduler/service-installer.js";
import {
  formatHeaderBanner,
  formatWaveTimelineTable,
  formatUsageReport,
  formatTopologyLabel
} from "./formatters.js";
import { autoDetectQualityGates, loadConfig } from "../config/loader.js";
import { Orchestrator } from "../core/orchestrator.js";

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await execa(cmd, ["--version"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function runFirstRunWizard(): Promise<WetGlobalConfig> {
  p.intro(pc.bold(pc.cyan("Benvenuto in WorthEveryToken (wet) v2 — Setup Iniziale")));

  const s = p.spinner();
  s.start("Rilevamento CLI installate nel PATH...");

  const [hasClaude, hasCodex, hasAgy, hasGemini] = await Promise.all([
    isCommandAvailable("claude"),
    isCommandAvailable("codex"),
    isCommandAvailable("agy"),
    isCommandAvailable("gemini")
  ]);

  s.stop("Rilevamento completato.");

  const providerOptions = [
    {
      value: "claude" as ProviderId,
      label: `Anthropic Claude Code ${hasClaude ? pc.green("(installato ✓)") : pc.dim("(non trovato)")}`,
      hint: "Consigliato per Opus e abbonamenti Claude Pro/Max"
    },
    {
      value: "codex" as ProviderId,
      label: `OpenAI Codex CLI ${hasCodex ? pc.green("(installato ✓)") : pc.dim("(non trovato)")}`,
      hint: "Consigliato per o3-mini e abbonamenti OpenAI Plus/Pro"
    },
    {
      value: "agy" as ProviderId,
      label: `Google Antigravity CLI (agy) ${hasAgy ? pc.green("(installato ✓)") : pc.dim("(non trovato)")}`,
      hint: "Consigliato per abbonamenti Google Agy Pro"
    },
    {
      value: "gemini" as ProviderId,
      label: `Google Gemini CLI ${hasGemini ? pc.green("(installato ✓)") : pc.dim("(non trovato)")}`,
      hint: "Consigliato per Gemini 2.5 Pro / Flash"
    },
    {
      value: "custom" as ProviderId,
      label: "Custom Provider (qualsiasi CLI esterna)",
      hint: "Configurabile con comandi personalizzati"
    }
  ];

  // Passaggio 1: Scegli l'unico provider attivo
  const defaultProvider = hasClaude ? "claude" : hasCodex ? "codex" : hasAgy ? "agy" : hasGemini ? "gemini" : "claude";

  const selectedProvider = await p.select({
    message: "Passaggio 1/3 — Scegli l'abbonamento AI attivo da ottimizzare:",
    options: providerOptions,
    initialValue: defaultProvider
  });

  if (p.isCancel(selectedProvider)) {
    p.cancel("Setup annullato.");
    process.exit(0);
  }

  const globalConfig = loadGlobalConfig();
  globalConfig.provider = selectedProvider as ProviderId;

  // Passaggio 2: Auto-rilevamento live
  s.start(`Passaggio 2/3 — Rilevamento automatico quota, bucket e topologia per ${selectedProvider}...`);
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  const usage = await adapter.probeUsage();
  s.stop("Rilevamento live completato.");

  const topology = classifyTopology(usage.buckets);
  const topologyLabel = formatTopologyLabel(topology.type);

  if (usage.weeklyResetAt && usage.weeklyUsedPct !== null) {
    p.note(
      `Topologia: ${pc.magenta(topologyLabel)}\nReset rilevato: ${pc.cyan(usage.weeklyResetAt.toLocaleString())}\nQuota usata: ${pc.yellow(`${usage.weeklyUsedPct}%`)} (residuo ${(100 - usage.weeklyUsedPct).toFixed(0)}%)`,
      "Topologia e Quota rilevate con successo ✓"
    );
  } else {
    p.note(
      `Topologia: ${pc.magenta(topologyLabel)}\nLa CLI non ha fornito la data di reset esatta. Verrà applicato il fallback (Lunedì 08:00).`,
      "Configurazione orario fallback"
    );
  }

  // Passaggio 3: Modalità invisibile in background
  const installWatcher = await p.confirm({
    message: "Passaggio 3/3 — Attivare la Modalità Invisibile in background (systemd/cron + Zero-Touch Git)?",
    initialValue: true
  });

  if (p.isCancel(installWatcher)) {
    p.cancel("Setup annullato.");
    process.exit(0);
  }

  saveGlobalConfig(globalConfig);

  if (installWatcher) {
    s.start("Installazione del watcher in background...");
    const res = await installBackgroundWatcher();
    s.stop(res.message);
    if (res.lingerWarning) {
      p.note(res.lingerWarning, "Avviso per sessioni SSH");
    }

    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, ".git"))) {
      armProject(cwd, { forceReplace: true });
      p.note(`Cartella corrente "${path.basename(cwd)}" armata automaticamente in modalità invisibile!`, "Progetto Armato");
    }
  }

  p.outro(pc.green("WorthEveryToken v2.1 configurato con successo!"));
  return globalConfig;
}

export async function runInteractiveMenu(): Promise<void> {
  if (!hasGlobalConfig()) {
    await runFirstRunWizard();
  }

  const globalConfig = loadGlobalConfig();
  const machineState = loadMachineState();
  const adapter = getAdapter(globalConfig.provider, globalConfig);
  const topModel = adapter.getTopModelProfile(globalConfig);
  const watcherStatus = await getWatcherStatus();

  // Try quick probe for display
  const usage: UsageSnapshot | null = machineState.lastKnownUsage
    ? {
        provider: machineState.lastKnownUsage.provider,
        probedAt: new Date(machineState.lastKnownUsage.probedAt),
        source: machineState.lastKnownUsage.source,
        buckets: machineState.lastKnownUsage.buckets ?? [],
        weeklyUsedPct: machineState.lastKnownUsage.weeklyUsedPct ?? null,
        weeklyResetAt: machineState.lastKnownUsage.weeklyResetAt ? new Date(machineState.lastKnownUsage.weeklyResetAt) : null,
        window5hUsedPct: machineState.lastKnownUsage.window5hUsedPct ?? null,
        window5hResetAt: machineState.lastKnownUsage.window5hResetAt ? new Date(machineState.lastKnownUsage.window5hResetAt) : null,
        detectedModel: machineState.lastKnownUsage.detectedModel
      }
    : null;

  const calibEngine = new CalibrationEngine();
  const { rate: ratePer5h } = calibEngine.getRateForProvider(globalConfig.provider, globalConfig.subscription_tier);

  const now = new Date();
  const topology = classifyTopology(usage?.buckets ?? []);
  const plan = computeExecutionPlan({
    topology,
    calibration: {
      primaryPctPerSubWindow: ratePer5h
    },
    config: {
      targetWeeklyBurnPct: globalConfig.schedule.target_weekly_burn_pct,
      windowHours: globalConfig.schedule.window_hours,
      waveBufferMinutes: globalConfig.schedule.wave_buffer_minutes,
      hardStopBeforeResetMinutes: globalConfig.schedule.hard_stop_before_reset_minutes,
      minTaskReserveMinutes: globalConfig.schedule.min_task_reserve_minutes,
      quietHours: globalConfig.schedule.quiet_hours
    },
    now
  });

  // Display banner
  console.log(
    formatHeaderBanner({
      provider: globalConfig.provider,
      model: topModel.model,
      usage,
      activeProject: machineState.activeProject,
      watcher: watcherStatus,
      plan,
      topologyType: topology.type
    })
  );

  const cwd = process.cwd();
  const isGit = fs.existsSync(path.join(cwd, ".git"));

  const action = await p.select({
    message: "Cosa desideri fare?",
    options: [
      {
        value: "arm",
        label: `1. Attiva / Pianifica questa cartella per il prossimo ciclo pre-reset`,
        hint: isGit ? cwd : "Attenzione: la cartella corrente non è un repo Git"
      },
      {
        value: "run_now",
        label: "2. Avvia una sessione adesso (Audit + Fix immediati sul progetto corrente)",
        hint: "Esegue subito la pipeline senza attendere il reset"
      },
      {
        value: "view_plan",
        label: "3. Mostra Piano Ondate & Stato dettagliato",
        hint: "Calcolo live ondate da 5h, timeline e calibrazione %"
      },
      {
        value: "view_report",
        label: "4. Apri / Stampa l'ultimo Report generato",
        hint: ".wet/REPORT-*.md"
      },
      {
        value: "disarm",
        label: "5. Disattiva / Annulla il progetto attualmente pianificato sulla macchina",
        hint: machineState.activeProject ? machineState.activeProject.repoName : "Nessuno armato"
      },
      {
        value: "settings",
        label: "6. Impostazioni (Cambia provider, watcher background, ricalibra)",
        hint: "Configurazione ~/.wet/config.yaml"
      },
      {
        value: "exit",
        label: "7. Esci",
        hint: "Termina il menu"
      }
    ]
  });

  if (p.isCancel(action) || action === "exit") {
    p.outro("Arrivederci!");
    return;
  }

  switch (action) {
    case "arm": {
      if (!isGit) {
        p.note("La cartella corrente non è una directory Git. Entra in una repo Git prima di armare.", "Errore");
        return;
      }

      const armResult = armProject(cwd, { forceReplace: false });
      if (armResult.conflict && armResult.existingProject) {
        const replace = await p.confirm({
          message: `Il progetto attivo attualmente è "${armResult.existingProject.repoName}" (${armResult.existingProject.repoPath}).\nVuoi annullare la pianificazione precedente e attivare questa cartella?`,
          initialValue: false
        });

        if (!replace || p.isCancel(replace)) {
          p.outro("Pianificazione precedente mantenuta inalterata.");
          return;
        }

        armProject(cwd, { forceReplace: true });
      }

      // Check quality gates
      const gates = autoDetectQualityGates(cwd);
      p.note(
        gates.map((g) => `• ${g.name}: ${g.cmd}`).join("\n"),
        "Quality gates rilevati automaticamente per questo progetto"
      );

      // Ensure .gitignore has .wet
      const gitignorePath = path.join(cwd, ".gitignore");
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, "utf-8");
        if (!content.includes(".wet")) {
          fs.appendFileSync(gitignorePath, "\n.wet/\n");
        }
      }

      p.outro(pc.green(`Progetto ${path.basename(cwd)} armato con successo!`));
      break;
    }

    case "run_now": {
      p.intro(pc.cyan("Avvio sessione immediata..."));
      const wetConfig = loadConfig(cwd);
      const orchestrator = new Orchestrator(wetConfig, adapter);
      await orchestrator.run({ resume: true });
      p.outro(pc.green("Sessione completata!"));
      break;
    }

    case "view_plan": {
      console.log("\n" + formatWaveTimelineTable(plan) + "\n");
      if (usage) {
        console.log(formatUsageReport(usage) + "\n");
      }
      p.outro("Piano visualizzato.");
      break;
    }

    case "view_report": {
      const wetDir = path.join(cwd, ".wet");
      if (!fs.existsSync(wetDir)) {
        p.note("Nessuna cartella .wet trovata in questo progetto.", "Info");
        return;
      }
      const files = fs.readdirSync(wetDir).filter((f) => f.startsWith("REPORT-") && f.endsWith(".md"));
      if (files.length === 0) {
        p.note("Nessun report generato trovato in .wet/", "Info");
        return;
      }
      files.sort().reverse();
      const latest = path.join(wetDir, files[0]!);
      const content = fs.readFileSync(latest, "utf-8");
      console.log("\n" + content + "\n");
      p.outro(`Report visualizzato: ${files[0]}`);
      break;
    }

    case "disarm": {
      const disarmed = disarmProject();
      if (disarmed) {
        p.outro(pc.yellow(`Progetto ${disarmed.repoName} disarmato. Nessun lavoro automatico in coda.`));
      } else {
        p.outro("Nessun progetto era armato.");
      }
      break;
    }

    case "settings": {
      const settingChoice = await p.select({
        message: "Cosa vuoi configurare?",
        options: [
          { value: "provider", label: "Cambia provider attivo" },
          { value: "watcher_install", label: "Reinstalla watcher di sistema" },
          { value: "watcher_uninstall", label: "Rimuovi watcher di sistema" },
          { value: "sync_benchmarks", label: "Sincronizza benchmark esterni adesso" }
        ]
      });

      if (p.isCancel(settingChoice)) return;

      if (settingChoice === "provider") {
        await runFirstRunWizard();
      } else if (settingChoice === "watcher_install") {
        const res = await installBackgroundWatcher();
        p.outro(res.message);
      } else if (settingChoice === "watcher_uninstall") {
        const res = await uninstallBackgroundWatcher();
        p.outro(res.message);
      } else if (settingChoice === "sync_benchmarks") {
        const s = p.spinner();
        s.start("Sincronizzazione benchmark da aicodingdaily.com...");
        await calibEngine.syncExternalBenchmarks(globalConfig.calibration.benchmark_source_url, 0);
        s.stop("Sincronizzazione completata.");
        p.outro("Cache aggiornata.");
      }
      break;
    }
  }
}
