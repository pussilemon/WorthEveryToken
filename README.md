# WorthEveryToken (`wqb` - Weekend Quota Burner)

Autonomous headless codebase auditor and weekend quota optimizer for **Claude Code** (`claude`) and **Antigravity CLI** (`agy`).

Designed to run unattended in the background before weekly quota resets to safely burn leftover token budgets through rigorous codebase auditing, atomic fixes, quality gates, and automated test expansion.

---

## Key Architectural Highlights

- **Profile 2 (Modular Headless CLI Orchestrator):** Built on Node.js 22+ LTS with strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), ESM, and native process management (`node-pty` + `execa`).
- **Disjoint Git Worktree Isolation (Pattern `chief-wiggum`):** Every task executes inside an isolated Git worktree (`.wqb/worktrees/<task-id>`). Tasks with disjoint target files can run concurrently without race conditions.
- **Dual-Condition Exit Gate (Pattern `ralph-claude-code`):** Enforces both exit code 0 and valid `<WQB_EXIT_SIGNAL status="DONE"/>` markers.
- **Anti-Hang PTY & Silence Watchdog (Google Antigravity CLI Issue #318):** `agy` runs inside a pseudo-terminal with dual independent timers (180s wall-clock and 60s silence watchdog) with automated fallback to Claude Code.
- **Incremental Quota Guard (Pattern `herdr-claude-usage`):** Reads `~/.claude/projects/**/*.jsonl` with tracked byte offsets to monitor 5-hour and 7-day rolling quota windows, shutting down cleanly at safety thresholds.
- **3-State Circuit Breaker (`CLOSED` -> `HALF_OPEN` -> `OPEN`):** Automatically halts the orchestrator on 3 consecutive failures, repeated error hashes, or degenerative burn loops.
- **Quality Gates & Auto-Repair Loop (Pattern `devsforge-orchestrator`):** Automatic sequential execution of `typecheck`, `lint`, and `test` in worktrees with automated repair sessions up to 3 retries.
- **Isolated Docker Sandbox:** Includes `docker/Dockerfile.sandbox` for non-root execution in headless container environments.

---

## Directory Structure

```text
WorthEveryToken/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── wqb.config.example.yaml       # Example configuration for budgets, limits, and routing
├── docker/
│   └── Dockerfile.sandbox        # Hardened non-root sandbox container
├── prompts/
│   ├── phase1-audit.md           # Read-only audit prompt -> structured backlog
│   ├── phase2-claude-fix.md      # Atomic execution prompt for critical fixes
│   ├── phase2-agy-digest.md      # Fast execution prompt for bulk tasks (agy + --digest)
│   └── phase3-repair.md          # Auto-repair prompt for quality gate failures
├── src/
│   ├── cli.ts                    # CLI entrypoint (init, audit, run, status, report, cleanup)
│   ├── config/
│   │   ├── schema.ts             # Zod contracts for wqb.config.yaml & tasks.json
│   │   └── loader.ts             # Configuration loader, auto-detection, prompt compiler
│   ├── core/
│   │   ├── orchestrator.ts       # Pipeline coordinator (Phase 1 -> DAG -> Phase 2/3)
│   │   ├── dag-scheduler.ts      # Topological sorting & disjoint file locking
│   │   ├── circuit-breaker.ts    # Anti-loop & dual-condition exit gate
│   │   └── quality-gates.ts      # Multi-stage gate runner with auto-repair loop
│   ├── git/
│   │   └── git-manager.ts        # Pre-flight checks, audit branch, isolated worktrees, cherry-pick
│   ├── adapters/
│   │   ├── agent-adapter.ts      # Common AgentAdapter interface & XML tag parser
│   │   ├── claude-adapter.ts     # Headless claude -p runner with rate-limit detector
│   │   └── agy-adapter.ts        # agy -p runner with node-pty, watchdog & fallback
│   ├── telemetry/
│   │   ├── quota-guard.ts        # Incremental JSONL reader for 5h/7d burn-rate
│   │   ├── burn-profiler.ts      # Heuristic and vendor/agentburn bridge
│   │   └── reporter.ts           # Final Markdown report generator (.wqb/REPORT-YYYYMMDD.md)
│   └── utils/
│       └── logger.ts             # Structured JSON & console logger (pino + pino-pretty)
├── tests/
│   ├── dag-scheduler.test.ts
│   ├── circuit-breaker.test.ts
│   ├── git-manager.test.ts
│   ├── agy-adapter.test.ts
│   └── quota-guard.test.ts
└── vendor/                       # Submodules (ralph-claude-code, devsforge-orchestrator, agentburn)
```

---

## Installation & CLI Usage

### Build from source

```bash
pnpm install
pnpm run build
```

Link the binary globally or use local `dist/cli.js`:

```bash
pnpm link --global
# or run directly: node dist/cli.js <command>
```

### Available Commands

1. **Initialize configuration:**
   ```bash
   wqb init
   ```
   Auto-detects project testing, linting, and typecheck scripts and creates `wqb.config.yaml`.

2. **Run read-only audit (Phase 1):**
   ```bash
   wqb audit [--max-tasks 20]
   ```
   Generates a structured prioritized backlog in `.wqb/tasks.json`.

3. **Execute audit & fix pipeline (Phase 2 & 3):**
   ```bash
   wqb run [--dry-run] [--workers 2] [--max-budget 25] [--resume]
   ```
   Creates dedicated `ai-weekend-audit-YYYYMMDD` branch and processes tasks across isolated worktrees.

4. **Inspect status and quota burn:**
   ```bash
   wqb status
   ```
   Shows backlog completion breakdown and 5-hour/7-day token spend.

5. **Generate report:**
   ```bash
   wqb report
   ```
   Produces `.wqb/REPORT-YYYYMMDD.md` ready for Monday morning PR review.

6. **Cleanup:**
   ```bash
   wqb cleanup
   ```
   Safely removes all temporary worktrees and task branches.

---

## Quality & Test Verification

Run the full Definition of Done verification suite:

```bash
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build
```

All 5 test suites pass with 100% coverage on core concurrency, rollback isolation, silence watchdogs, and quota guards.

---

## Submodules

This repository references:
- `vendor/ralph-claude-code` (Fork of `frankbria/ralph-claude-code`)
- `vendor/devsforge-orchestrator` (Fork of `devsforge/orchestrator`)
- `vendor/agentburn` (Fork of `Socialpranker/agentburn`)

To clone with submodules:
```bash
git clone --recurse-submodules https://github.com/pussilemon/WorthEveryToken.git
```
