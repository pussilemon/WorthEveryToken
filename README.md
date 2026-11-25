# WorthEveryToken (`wet`)

Autonomous, single-provider codebase auditor, test expander, and rolling-wave token burner.

WorthEveryToken systematically burns unused AI subscription quotas (Claude Code, OpenAI Codex, Antigravity, Gemini CLI, or Custom CLI) before weekly or daily resets, channeling excess capacity into high-impact code reliability improvements, test expansion, and automated refactoring with 100% Zero-Touch Git isolation.

---

## How It Works

WorthEveryToken operates as a fully autonomous background daemon designed to maximize the value of your AI developer subscriptions without ever risking overage, bleed into the next billing cycle, or interference with active development.

### 1. Universal Quota Topology
Unlike rigid single-window tools, `wet` understands how modern AI subscription models work:
- **`MULTI_BUCKET_CASCADE`**: Handles accounts with both rolling sub-windows (e.g. 5-hour rolling) and primary macro quotas (e.g. weekly 168h limit), as well as separate model tier limits (e.g. Claude Opus vs. Sonnet, or OpenAI o3 vs. GPT-4o). Automatically cascades from top-tier models down to secondary models when the primary tier exhausts.
- **`SINGLE_CYCLE_CAP`**: For providers offering fixed daily (24h) or weekly (168h) quotas without rolling sub-windows.
- **`ROLLING_ONLY`**: For providers constrained exclusively by rolling windows (e.g. 3h or 5h).
- **`FAIL_CLOSED_UNKNOWN_RESET` (Fail-Closed Safety)**: If quota reset timestamps cannot be detected or verified with certainty, `wet` safely refuses to burn tokens rather than risking bleed into a new cycle.

### 2. Autonomous Wave Planner & EMA Calibration
`wet` automatically calculates the optimal moment to start burning tokens before your quota resets:
- **Dynamic Wave Sizing**: Computes exactly how many 5-hour sub-windows ($N$) are required to safely burn leftover tokens without exceeding rolling caps.
- **Lead-Time Calculation**: Schedules execution to commence $(N \times \text{windowHours} + \text{buffer})$ prior to the reset timestamp.
- **Field EMA Calibration**: Continuously tracks and refines token burn velocity per wave using Exponential Moving Average (EMA):
  $$\text{newRate} = \alpha \cdot \Delta + (1 - \alpha) \cdot \text{oldRate}$$
  Ensures wave projections remain accurate over time across real-world workloads.

### 3. 5-Level Zero-Bleed Cycle Guard
Five concentric safety barriers ensure your quotas are never exhausted during working hours and never spill into subsequent billing cycles:
1. **Level 1 (Pre-Reset Hard Stop)**: Automatically halts execution 20 minutes before the billing cycle reset.
2. **Level 2 (Task-Level Pre-Flight Budget Check)**: Estimates remaining task duration against time remaining until the hard stop; skips tasks that cannot finish cleanly before cutoff.
3. **Level 3 (Early-Reset Immediate Abort)**: Continuously checks quota reset indicators; immediately halts the wave if an unexpected early cycle reset is detected.
4. **Level 4 (Active User Guard & Off-Hours Window)**: Pauses autonomous background runs if developer activity (file edits, unstaged or staged git changes within 15 minutes) is detected on the active repository. Operates exclusively within designated off-hours (`22:00` - `08:00` and weekends) to avoid consuming tokens during daytime work (unless quota expires within 6 hours and developer is idle).
5. **Level 5 (Fail-Closed Protection & Fallback Schedule Confirmation)**: Aborts background scheduling (`FAIL_CLOSED_UNKNOWN_RESET`) if quota status or reset schedule cannot be authoritatively determined. When using CLIs that do not expose live quota timestamps (such as `agy`), confirming your weekly reset day and time via the menu locks in `fallback_schedule_confirmed: true`, activating safe off-hours waves with strict pre-reset Hard Stop protection.

### 4. Zero-Touch Git Invisibility & Audit Isolation
`wet` guarantees complete safety for user repositories:
- **Phase 1 (Audit Worktree)**: Read-only exploration executes inside an ephemeral detached worktree (`.wet/audit-worktree`). Any untracked or modified files created during AI analysis are discarded completely upon completion, preserving developer working copies and active branches in their exact original state.
- **Phase 2 & 3 (Task Worktrees & Cherry-Pick Head)**: Each task executes in an isolated worktree (`.wet/task-worktree`), runs quality gates, and integrates verified commits into `.wet/audit-head` (`ai-weekend-audit-YYYYMMDD`). Developer branches and uncommitted changes are never touched or modified.

### 5. Multi-Stage Quality Gates & Self-Repair
Every code change must satisfy strict automated verification:
- Automatic detection of project toolchains (TypeScript `tsc`, ESLint, Prettier, Jest/Vitest, Cargo, Pytest, Go test).
- 3-Phase verification: Typecheck $\rightarrow$ Lint $\rightarrow$ Unit Tests & Coverage.
- Autonomous Auto-Repair: On gate failure, provides the compiler/test error diff back to the AI adapter for up to 3 repair attempts before tripping the circuit breaker.

---

## Installation

### Prerequisites
- **Node.js**: version 20.x or higher
- **pnpm**: version 8.x or higher (or `npm`)
- **Git**: version 2.28 or higher
- An active AI CLI tool in your `PATH` (`claude`, `codex`, `agy`, or `gemini`)

### Global Setup

Clone and install dependencies:
```bash
git clone https://github.com/pussilemon/WorthEveryToken.git
cd WorthEveryToken
pnpm install
pnpm run build
npm link
```

Verify installation:
```bash
wet --version
wet --help
```

---

## Usage

### 1. Interactive TUI (Recommended)
Simply run `wet` without arguments to launch the interactive terminal interface:
```bash
wet
```
- **First Launch**: Automatically detects installed AI CLIs in your `PATH`, lets you configure your primary provider and subscription tier, performs a live quota probe, and offers to set up the background watcher.
- **Repository Context**: Inside any Git repository, `wet` displays current quota status, computed wave timelines, and options to arm the project, run an immediate audit, or execute tasks.

### 2. Arming a Repository
WorthEveryToken enforces a single active project per machine to avoid concurrent quota competition:
```bash
cd /path/to/my-repo
wet arm
```
To switch active projects:
```bash
wet arm --force
```
To disarm:
```bash
wet disarm
```

### 3. Probing Usage & Wave Plan
Inspect your provider's live quota, detected topology, and computed execution timeline:
```bash
wet probe
```

### 4. Direct CLI Execution
You can run audits and execution waves directly from the terminal:
```bash
# Initialize project config and auto-detect quality gates
wet init

# Run Phase 1 read-only codebase audit
wet audit

# Run full audit and task execution pipeline
wet run

# Resume previous run without restarting finished tasks
wet run --resume

# Check backlog status and progress
wet status

# View latest Markdown telemetry report
wet report

# Clean up temporary worktrees and branches
wet cleanup
```

---

## Background Daemon & SSH Headless Setup

To run `wet` unattended on Linux servers and developer workstations without keeping terminal sessions open:

### Install Service
```bash
wet service install
```
This registers a `systemd --user` timer (`wet-watch.timer`) that runs every 15 minutes with zero resident RAM consumption when idle. On non-systemd environments, it automatically configures a user cron job.

### Persistent SSH Sessions (Linger)
For headless servers and SSH connections, enable systemd lingering so timers run even after disconnecting:
```bash
loginctl enable-linger $USER
```

### Manage Service
```bash
# Check service status
wet service status

# Inspect systemd timer
systemctl --user list-timers | grep wet

# Tail service execution logs
journalctl --user -u wet-watch.service -n 50 -f

# Uninstall background service
wet service uninstall
```

---

## Configuration

Global settings are stored in `~/.wet/config.yaml`. Project-level overrides can be placed in `wet.config.yaml` at your repository root:

```yaml
project:
  root: "."
  base_branch: "main"
  audit_branch_prefix: "ai-weekend-audit"
  worktree_dir: ".wet/worktrees"
  max_parallel_workers: 1

limits:
  max_total_tasks: 25
  max_retries_per_task: 3
  max_consecutive_failures: 3
  claude_max_turns_per_task: 18
  claude_max_budget_usd_per_task: 2.5
  stop_at_five_hour_quota_pct: 90
  stop_at_weekly_quota_pct: 95

quality_gates:
  auto_detect: true
  gate_timeout_sec: 120
```

---

## Development & Verification

Run the full verification pipeline:
```bash
pnpm run typecheck    # Strict TypeScript checks (noUncheckedIndexedAccess)
pnpm run lint         # ESLint (0 errors, 0 warnings enforced)
pnpm test             # 18 test suites, 110 unit tests
pnpm run build        # Production compile to dist/
```

---

## License

MIT
