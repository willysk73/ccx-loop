# ccx-loop

Claude Code plugin for automated dev loops with Codex review gates.

Implement a task, get it reviewed by Codex, fix findings, repeat — then commit. All in one command.

The plugin ships four commands:

| Command | Behavior |
|---------|----------|
| `/ccx:loop`       | Run a fixed number of review-fix cycles (default 2). |
| `/ccx:forever`    | Repeat review-fix cycles until Codex approves (safety cap default 100). |
| `/ccx:plan`       | Seed (or extend with `--append`) `BOARD.md` task rows from a prompt or document — onboarding path for `/ccx:supervisor`. |
| `/ccx:supervisor` | Dispatch N parallel `/ccx:loop` workers from a shared `BOARD.md` (dispatch + autonomous chat_ask + scope-overlap gate + pre-merge squash + automatic tier escalation across a 5-rung model ladder). |

## Install

```bash
# 1. Add the marketplace
claude plugin marketplace add willysk73/ccx-loop

# 2. Install the plugin
claude plugin install ccx@ccx-loop
```

Or from inside Claude Code:

```
/plugin marketplace add willysk73/ccx-loop
/plugin install ccx@ccx-loop
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Codex](https://github.com/openai/codex) plugin (for review gates)
- Node.js ≥ 18.17 (only required if you enable the optional Discord chat bridge)

### Optional: Discord chat bridge

`/ccx:loop --chat` and `/ccx:forever --chat` mirror the run into a Discord channel — cycle summaries, stuck-finding reports, and the commit prompt are sent to chat, and your reply unblocks the loop. Multiple concurrent sessions are supported; each has a short `#id` and the bot can `!ccx sessions` / `!ccx focus <id>` / `!ccx cancel <id>` at any time.

One-time setup:

```
/ccx:chat-setup
```

This installs `discord.js` + MCP SDK into the plugin, creates `~/.claude/ccx-chat/config.json`, and smoke-tests the broker. You need a Discord bot token and the channel ID to use.

## Usage

### `/ccx:loop` — fixed N cycles

```
/ccx:loop [--loops N] [--min-severity LEVEL] [--min-confidence N] [--commit] <task>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--loops N` | Number of review-fix cycles (1–20) | 2 |
| `--min-severity LEVEL` | Ignore findings below `critical\|high\|medium\|low` | `low` (fix all) |
| `--min-confidence N` | Ignore findings with confidence < N (0.0–1.0) | `0.0` |
| `--commit` | Auto-commit on clean exit (gated) | off |

### `/ccx:forever` — loop until approval

```
/ccx:forever [--max-cycles N] [--min-severity LEVEL] [--min-confidence N] [--commit] <task>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--max-cycles N` | Safety cap; loop exits on first approval anyway (1–100) | 100 |
| `--min-severity LEVEL` | Ignore findings below `critical\|high\|medium\|low` | `low` (fix all) |
| `--min-confidence N` | Ignore findings with confidence < N (0.0–1.0) | `0.0` |
| `--commit` | Auto-commit on clean approval (gated) | off |

### `/ccx:plan` — seed BOARD.md

```
/ccx:plan <prompt> | --from <path> [--append]
```

Takes a free-form prompt or a reference to a document the user already wrote (PRD, design note, ticket export), grounds `scope.include` globs on actual repo files, and writes task rows to `BOARD.md` as `status: draft`. The human reviews the draft, flips `draft → pending`, commits, and then runs `/ccx:supervisor`. This is the onboarding path for the supervisor — no need to learn the BOARD YAML schema by hand.

| Flag | Description | Default |
|------|-------------|---------|
| `--from <path>` | Read a file as the planning context (PRD/design note/etc). Relative paths resolve against the repo root. | (use positional prompt) |
| `--append` | Extend an existing `BOARD.md` — new rows appended at the end of the `## Tasks` block; existing rows preserved byte-for-byte. | off (fresh seed) |

### `/ccx:supervisor` — parallel orchestrator

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--max-attempts N] [--start-tier <alias>] [--chat] [--dry-run]
```

Drives N parallel `/ccx:loop` workers from a shared `BOARD.md` at the repo root. Each task gets its own worktree, brief file (`.ccx/tasks/T-<id>.md`), and a squash merge commit on approval. Worker `chat_ask` calls are intercepted by the broker and answered autonomously from the brief / BOARD direction / merge history when possible; ambiguous asks escalate to Discord. When a worker exits without approval, the supervisor re-dispatches the task automatically along a fixed 5-rung model ladder — `haiku(medium) → sonnet(medium) → opus(high) → opus(xhigh) → opus(max)` — bumping one rung on `stuck` exits and retrying the same rung on `cycle-cap`, until the task merges or the `--max-attempts` budget runs out. A `stuck` exit at the top rung (`opus/max`) is the only remaining human gate.

| Flag | Description | Default |
|------|-------------|---------|
| `--parallel N` | Max concurrent workers (1–10) | 3 |
| `--integration BRANCH` | Branch merges land on | current branch |
| `--max-tasks M` | Stop after M merges | unlimited |
| `--worker-loops N` | `--loops N` passed to each worker (1–20) | 3 |
| `--max-attempts N` | Max automatic worker dispatches per task (tier bumps + same-tier retries). Exempt branch: `opus/max` stuck → human prompt. | 4 |
| `--start-tier <alias>` | First-attempt rung on the 5-rung ladder: `haiku \| sonnet \| opus \| opus-xhigh \| opus-max` | `sonnet` |
| `--chat` | Register a supervisor session with the ccx-chat broker and post lifecycle events (dispatch, merge, block, stuck prompt, run end) to Discord | off |
| `--dry-run` | Print dispatch plan, don't commit or spawn | off |

Milestones shipped: M1 dispatch + naive merge, M2 broker supervisor adapter, M3 autonomous chat_ask answering, M4 scope-overlap gate + pre-merge dry-run, M5 stuck-exit auto-revise + re-dispatch, M6 `/ccx:plan` onboarding (separate command above), M7 automatic model tier escalation. See `docs/supervisor-design.md` for the full design.

### Examples

```bash
# Basic: implement + 2 review cycles + ask to commit
/ccx:loop Add user login with JWT authentication

# 3 review cycles
/ccx:loop --loops 3 Fix pagination bug in /api/users endpoint

# Loop until Codex approves
/ccx:forever Refactor database queries to use connection pooling

# Loop until approved, only fix medium+ findings, auto-commit on success
/ccx:forever --min-severity medium --commit Tighten input validation

# 1 cycle + auto-commit
/ccx:loop --loops 1 --commit Update error messages in validation middleware
```

## How it works

```
Phase 0: Pre-check (dirty working tree? parse PRE_LOOP_PATHS)
    ↓
Phase 1: Implement the task (+ test gate)
    ↓
Phase 2: Review loop
    ┌─→ Codex review (JSON verdict)
    │       ↓
    │   Stuck-finding check (same finding × 3 cycles → stop)
    │       ↓
    │   Fix in-scope findings (with fix verification)
    │       ↓
    └── Exit or next cycle
    ↓
Phase 3: Update .handoff.md (if exists)
    ↓
Phase 4: Commit (gated — unresolved / test failure / cap-hit / stuck-exit block auto-commit)
```

### Key behaviors

- **One-approval exit.** `/ccx:loop` exits as soon as Codex approves (no pointless re-review of unchanged code). `/ccx:forever` exits on first approval too.
- **Severity & confidence filtering.** Skip low-value findings to reduce cycles. Skipped findings are logged.
- **Stuck-finding detection.** If the same finding (keyed by `(file, title, body)`, line-agnostic) reappears three cycles in a row, the loop stops — further cycles are unlikely to converge.
- **Fix verification.** Edit/Write failures are surfaced as `unresolved`, never silently absorbed.
- **Auto-commit gate.** `--commit` only fires when the loop exited cleanly (approved/filtered-clean), tests pass, and no findings are unresolved. Otherwise it downgrades to an interactive prompt.
- **Explicit staging.** Only files the loop intentionally edits (Edit/Write + intentional Bash ops like `mv`, `rm`, formatters) are staged. Generated artifacts like coverage output never slip in.
- **Dirty-tree handling.** Pre-existing uncommitted changes are parsed via `git status -z` and handled explicitly. A hunk-granularity caveat is documented: if Claude edits a file that was already dirty, the user's prior hunks will be committed too (stash to avoid).

If Codex is not installed, implementation is preserved on disk and you're prompted to install it — no unreviewed commit.

## License

MIT
