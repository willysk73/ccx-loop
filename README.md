# ccx-loop

Claude Code plugin for automated dev loops with Codex review gates.

Implement a task, get it reviewed by Codex, fix findings, repeat — then commit. All in one command.

## Install

```bash
# 1. Add the marketplace
claude plugin marketplace add willysk73/ccx-loop

# 2. Install the plugin
claude plugin install ccx-loop@ccx-loop
```

Or from inside Claude Code:

```
/plugin marketplace add willysk73/ccx-loop
/plugin install ccx-loop@ccx-loop
```

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- [Codex](https://github.com/openai/codex) plugin (for review gates)

## Usage

```
/ccx-loop <task description>
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--loops N` | Number of review-fix cycles | 2 |
| `--until-approval` | Repeat until Codex approves (max 20) | - |
| `--commit` | Auto-commit without prompting | off |

### Examples

```bash
# Basic: implement + 2 review cycles + ask to commit
/ccx-loop Add user login with JWT authentication

# 3 review cycles
/ccx-loop --loops 3 Fix pagination bug in /api/users endpoint

# Loop until Codex approves
/ccx-loop --until-approval Refactor database queries to use connection pooling

# 1 cycle + auto-commit
/ccx-loop --loops 1 --commit Update error messages in validation middleware
```

## How it works

```
Phase 0: Pre-check (dirty working tree?)
    ↓
Phase 1: Implement the task
    ↓
Phase 2: Review loop
    ┌─→ Codex review (JSON verdict)
    │       ↓
    │   Fix all findings
    │       ↓
    └── Next cycle (or exit on approval)
    ↓
Phase 3: Update .handoff.md (if exists)
    ↓
Phase 4: Commit
```

- **Fixed N mode**: runs exactly N review-fix cycles. Early exits if 2 consecutive approvals.
- **Until-approval mode**: repeats until Codex returns `approve`. Safety cap at 20 cycles.
- All severity levels (critical/high/medium/low) are fixed — no findings are skipped.
- If Codex is not installed, implementation is preserved and you're prompted to install it.

## License

MIT
