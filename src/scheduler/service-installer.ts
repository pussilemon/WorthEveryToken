import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { logger } from "../utils/logger.js";
import { getGlobalWetDir } from "../config/global-store.js";

export interface WatcherServiceStatus {
  installed: boolean;
  method?: "systemd" | "cron";
  active?: boolean;
  details: string;
}

export function getCliPath(): string {
  // Finds the path to dist/cli.js
  const scriptPath = process.argv[1];
  if (scriptPath && (scriptPath.endsWith("cli.js") || scriptPath.endsWith("cli.ts"))) {
    return path.resolve(scriptPath);
  }
  // Fallback to local repo dist/cli.js if found
  const candidate = path.resolve(process.cwd(), "dist/cli.js");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(getGlobalWetDir(), "../WorthEveryToken/dist/cli.js");
}

export async function isSystemdUserAvailable(): Promise<boolean> {
  try {
    const { exitCode } = await execa("systemctl", ["--user", "status"], { timeout: 3000 });
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function isLingerEnabled(username?: string): Promise<boolean> {
  const user = username ?? process.env.USER ?? os.userInfo().username;
  try {
    const { stdout } = await execa("loginctl", ["show-user", user, "--property=Linger"]);
    return stdout.includes("Linger=yes");
  } catch {
    return false;
  }
}

export async function installBackgroundWatcher(): Promise<{
  method: "systemd" | "cron";
  message: string;
  lingerWarning?: string;
}> {
  const systemdAvailable = await isSystemdUserAvailable();
  const cliPath = getCliPath();
  const nodePath = process.execPath;
  const username = process.env.USER ?? os.userInfo().username;

  if (systemdAvailable) {
    const userSystemdDir = path.join(os.homedir(), ".config/systemd/user");
    fs.mkdirSync(userSystemdDir, { recursive: true });

    const servicePath = path.join(userSystemdDir, "wet-watch.service");
    const timerPath = path.join(userSystemdDir, "wet-watch.timer");

    const serviceContent = `[Unit]
Description=WorthEveryToken Background Watcher
After=network.target

[Service]
Type=oneshot
ExecStart=${nodePath} ${cliPath} watch
Environment="PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}"
StandardOutput=journal
StandardError=journal
`;

    const timerContent = `[Unit]
Description=Run WorthEveryToken Watcher every 15 minutes

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
`;

    fs.writeFileSync(servicePath, serviceContent, "utf-8");
    fs.writeFileSync(timerPath, timerContent, "utf-8");

    await execa("systemctl", ["--user", "daemon-reload"]);
    await execa("systemctl", ["--user", "enable", "--now", "wet-watch.timer"]);

    const linger = await isLingerEnabled(username);
    let lingerWarning: string | undefined;
    if (!linger) {
      lingerWarning = `Per mantenere attivo il timer dopo la chiusura della sessione SSH, esegui:\n  loginctl enable-linger ${username}`;
    }

    logger.info("Successfully installed wet-watch systemd --user timer");
    return {
      method: "systemd",
      message: "Timer systemd --user installato e attivato con frequenza ogni 15 minuti.",
      lingerWarning
    };
  }

  // Fallback to crontab
  const logPath = path.join(getGlobalWetDir(), "watch.log");
  const cronLine = `*/15 * * * * ${nodePath} ${cliPath} watch >> ${logPath} 2>&1 # wet-watch`;

  let currentCrontab = "";
  try {
    const { stdout } = await execa("crontab", ["-l"]);
    currentCrontab = stdout;
  } catch {
    // No crontab for user yet
  }

  const lines = currentCrontab.split("\n").filter((l) => !l.includes("# wet-watch") && l.trim().length > 0);
  lines.push(cronLine);

  const newCrontab = lines.join("\n") + "\n";
  const proc = execa("crontab", ["-"]);
  proc.stdin?.write(newCrontab);
  proc.stdin?.end();
  await proc;

  logger.info("Successfully installed wet-watch in crontab");
  return {
    method: "cron",
    message: "Watch job installato nel crontab con frequenza ogni 15 minuti."
  };
}

export async function uninstallBackgroundWatcher(): Promise<{ success: boolean; message: string }> {
  let removedAny = false;

  // Try systemd
  const userSystemdDir = path.join(os.homedir(), ".config/systemd/user");
  const timerPath = path.join(userSystemdDir, "wet-watch.timer");
  const servicePath = path.join(userSystemdDir, "wet-watch.service");

  if (fs.existsSync(timerPath) || fs.existsSync(servicePath)) {
    try {
      await execa("systemctl", ["--user", "disable", "--now", "wet-watch.timer"]);
    } catch {
      // Ignore
    }
    if (fs.existsSync(timerPath)) fs.unlinkSync(timerPath);
    if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
    try {
      await execa("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // Ignore
    }
    removedAny = true;
  }

  // Try crontab
  try {
    const { stdout } = await execa("crontab", ["-l"]);
    if (stdout.includes("# wet-watch")) {
      const filtered = stdout
        .split("\n")
        .filter((l) => !l.includes("# wet-watch"))
        .join("\n")
        .trim();
      const proc = execa("crontab", ["-"]);
      proc.stdin?.write(filtered ? filtered + "\n" : "");
      proc.stdin?.end();
      await proc;
      removedAny = true;
    }
  } catch {
    // Ignore
  }

  return {
    success: true,
    message: removedAny ? "Watcher in background rimosso con successo." : "Nessun watcher attivo trovato."
  };
}

export async function getWatcherStatus(): Promise<WatcherServiceStatus> {
  // Check systemd timer
  try {
    const { stdout } = await execa("systemctl", ["--user", "is-active", "wet-watch.timer"]);
    if (stdout.trim() === "active") {
      return {
        installed: true,
        method: "systemd",
        active: true,
        details: "Timer systemd --user attivo (ogni 15m)"
      };
    }
  } catch {
    // Not active or not installed
  }

  // Check crontab
  try {
    const { stdout } = await execa("crontab", ["-l"]);
    if (stdout.includes("# wet-watch")) {
      return {
        installed: true,
        method: "cron",
        active: true,
        details: "Crontab job attivo (ogni 15m)"
      };
    }
  } catch {
    // Crontab not found
  }

  return {
    installed: false,
    active: false,
    details: "Nessun watcher in background installato"
  };
}
