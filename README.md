# ccx-loop

Claude Code plugin for automated dev loops with Codex review gates.

Implement a task, get it reviewed by Codex, fix findings, repeat — then commit. All in one command.

The plugin ships two commands:

| Command | Behavior |
|---------|----------|
| `/ccx:loop`    | Run a fixed number of review-fix cycles (default 2). |
| `/ccx:forever` | Repeat review-fix cycles until Codex approves (safety cap default 100). |

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
