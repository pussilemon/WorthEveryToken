# WorthEveryToken (`wet`) v2

Autonomous, single-provider codebase auditor, test expander, and rolling-wave token burner.

Designed to eliminate unused AI subscription tokens before weekly resets. `wet` probes your provider's quota, calculates dynamic 5-hour execution waves, and runs unattended in the background to systematically burn leftover quotas on high-impact code reliability improvements.

---

## What's New in v2

1. **Interactive Terminal TUI:**
   - Type `wet` with no arguments to launch an interactive terminal interface (`@clack/prompts`).
   - First run opens a guided setup wizard detecting installed CLIs (`claude`, `codex`, `agy`, `gemini`).
   - Contextual daily menu in any Git repository for immediate execution, wave timeline inspection, and project arming.

2. **Single Universal Provider (Zero Multi-Subscription Lock-In):**
   - Choose **one active provider** (`claude`, `codex`, `agy`, `gemini`, or `custom`).
   - That provider autonomously executes all 3 phases (Audit, Fix & Test, and Auto-Repair) using its top model at maximum reasoning effort.

3. **Machine-Wide Single Active Project Enforcement:**
   - Global state persisted in `~/.wet/` (`config.yaml`, `state.json`, `calibration.json`, `benchmarks-cache.json`).
   - Only one repository can be armed at a time. Arming a new project automatically warns and requires explicit confirmation (`--force`).

4. **Dynamic 5-Hour Wave Scheduler & Pre-Reset Hard Stop:**
   - Live quota probe detects remaining weekly % and reset timestamp.
   - Calculates needed 5-hour waves: $N = \lceil \text{remainingPct} / \text{weeklyPctPer5hWave} \rceil$.
   - Automatically schedules execution to start $(N \times 5\text{h} + \text{buffer})$ before the weekly reset.
   - **Hard Stop:** Enforces a hard stop 10 minutes before weekly reset to never consume next week's quota.

5. **Field EMA Calibration Engine:**
   - Calibrates observed consumption per 5h wave using Exponential Moving Average:
     $$\text{newRate} = \alpha \cdot \Delta + (1 - \alpha) \cdot \text{oldRate}$$
   - Includes built-in offline presets and defensive synchronization with `https://aicodingdaily.com/subscription-usage`.

6. **Zero-RAM Background Watcher (`wet watch`):**
   - Managed via `systemd --user` timer on Linux (`wet-watch.timer` running every 15 min) or `cron` fallback.
   - Immune to SSH disconnections (`loginctl enable-linger $USER`). Zero RAM consumed while idle.

---

## Directory Structure

```text
WorthEveryToken/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── wet.config.example.yaml
├── docker/
│   └── Dockerfile.sandbox
├── prompts/
│   ├── phase1-audit.md           # Universal read-only audit prompt -> JSON backlog
│   ├── phase2-execute.md         # Universal atomic task execution prompt
│   ├── phase2-claude-fix.md      # Legacy Claude fix prompt
│   ├── phase2-agy-digest.md      # Fast execution prompt for agy
│   └── phase3-repair.md          # Universal auto-repair prompt
├── src/
│   ├── cli.ts                    # Entrypoint: interactive TUI default + subcommands
│   ├── ui/
│   │   ├── interactive-menu.ts   # First-run wizard + contextual project menu
│   │   └── formatters.ts         # Tables & boxes for banners, quotas, and wave timelines
│   ├── config/
│   │   ├── schema.ts             # GlobalConfigSchema, MachineStateSchema, TaskSchema
│   │   ├── global-store.ts       # Atomic ~/.wet/ store & single active project enforcement
│   │   └── loader.ts             # Project config loader & quality gates auto-detection
│   ├── core/
│   │   ├── orchestrator.ts       # Wave coordinator & multi-pass executor
│   │   ├── dag-scheduler.ts      # Disjoint file locking & topological execution
│   │   ├── circuit-breaker.ts    # Anti-loop & consecutive failure detection
│   │   └── quality-gates.ts      # Multi-stage gate runner with auto-repair loop
│   ├── git/
│   │   └── git-manager.ts        # Pre-flight checks, isolated worktrees, post-audit cleanup
│   ├── adapters/
│   │   ├── agent-adapter.ts      # Universal AgentAdapter interface & usage parser
│   │   ├── registry.ts           # Adapter factory (claude, codex, agy, gemini, custom)
│   │   ├── claude-adapter.ts     # Claude Code adapter (PTY usage probe + NDJSON stream)
│   │   ├── codex-adapter.ts      # OpenAI Codex CLI adapter (--sandbox read-only / write)
│   │   ├── agy-adapter.ts        # Antigravity CLI adapter (PTY + issue #318 watchdog)
│   │   ├── gemini-adapter.ts     # Gemini CLI adapter (JSON stream + rate limit detection)
│   │   └── custom-adapter.ts     # Generic YAML-configurable CLI wrapper
│   ├── scheduler/
│   │   ├── wave-planner.ts       # Pure wave calculation, lead time, and action planner
│   │   ├── calibration-engine.ts # Built-in presets, benchmarks cache, and EMA calibration
│   │   ├── watcher.ts            # wet watch runner (PID lock, wave execution, state transitions)
│   │   └── service-installer.ts  # systemd --user timer & cron installer
│   ├── telemetry/
│   │   ├── quota-guard.ts        # Sliding-window JSONL scanner for Claude
│   │   ├── burn-profiler.ts      # Heuristic task anomaly profiler
│   │   └── reporter.ts           # Markdown report generator (.wet/REPORT-YYYYMMDD.md)
│   └── utils/
│       └── logger.ts             # Structured JSON & console logger (pino + pino-pretty)
└── tests/                        # 12 test suites, 53 unit tests passing
```

---

## Installation & Quick Start

### Build and link globally

```bash
git clone https://github.com/pussilemon/WorthEveryToken.git
cd WorthEveryToken
pnpm install
pnpm run build
pnpm link --global
```

### Launch Interactive TUI

Simply type:
```bash
wet
```
- On first launch, the wizard will guide you through provider selection and background service installation.
- In any Git repository, typing `wet` presents options to arm the project, inspect computed waves, or start an immediate session.

---

## CLI Reference

| Command | Description |
|---|---|
| `wet` | Launches interactive TUI (wizard or project menu) |
| `wet watch` | Runs one background tick (invoked every 15 min by systemd/cron) |
| `wet arm [--force]` | Arms current repository as the active project |
| `wet disarm` | Cancels scheduled wave execution |
| `wet probe` | Interrogates provider CLI for live usage and prints wave timeline |
| `wet service install` | Installs `systemd --user` timer (or cron job) |
| `wet service uninstall`| Uninstalls background watcher service |
| `wet service status` | Checks background watcher status |
| `wet audit` | Runs Phase 1 read-only codebase audit |
| `wet run [--resume]` | Runs audit + fix pipeline directly |
| `wet status` | Displays backlog status and quota summary |
| `wet report` | Prints latest Markdown report |
| `wet cleanup` | Prunes orphan worktrees and branches |

---

## Background Watcher on Linux (SSH Sessions)

When using `systemd --user`, ensure lingering is enabled so timers persist after closing SSH:

```bash
loginctl enable-linger $USER
```

Check timer status:
```bash
systemctl --user list-timers | grep wet
```

View watcher execution logs:
```bash
journalctl --user -u wet-watch.service -n 50 --no-pager
```

---

## Verification & Testing

```bash
pnpm run typecheck    # Strict TypeScript verification
pnpm run lint         # ESLint check (0 warnings enforced)
pnpm test             # Vitest test suite (53 tests)
pnpm run build        # Production build to dist/
```

License: MIT
