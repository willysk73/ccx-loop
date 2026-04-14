---
description: "Automated dev loop — (implement → codex review → fix) × N → handoff → commit"
argument-hint: "[--loops N | --until-approval] [--commit] <task description>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate
---

# Dev Loop

Fully automated development workflow with configurable Codex review gates.

Raw arguments: `$ARGUMENTS`

---

## Argument Parsing

Parse the raw arguments:
- `--loops N` — number of review-fix cycles (default: 2). Mutually exclusive with `--until-approval`.
- `--until-approval` — repeat review-fix cycles until Codex approves (max 20 cycles as safety cap). Mutually exclusive with `--loops N`.
- `--commit` — auto-commit without asking (skip the prompt)
- Everything else is the **task description**

Examples:
- `/ccx-loop --loops 3 Fix pagination bug in /api/users` → 3 review cycles, ask commit, task = "Fix pagination bug in /api/users"
- `/ccx-loop --until-approval Refactor auth middleware` → cycles until approve (max 20), ask commit, task = "Refactor auth middleware"
- `/ccx-loop --commit Add input validation to signup form` → 2 review cycles, auto-commit, task = "Add input validation to signup form"
- `/ccx-loop --loops 1 --commit Update error messages` → 1 review cycle, auto-commit, task = "Update error messages"

---

## Rules

- Execute all phases sequentially. Do NOT pause between phases.
- Do NOT ask for user confirmation between phases (except commit when `--commit` is not set).
- Fix ALL review findings — critical, high, medium, low. No exceptions.
- If a review returns `verdict: "approve"` with zero findings, skip the fix step and proceed to the next cycle or finalization.
- Early exit (fixed N mode): if two consecutive reviews both return `verdict: "approve"`, skip remaining cycles.
- Exit condition (until-approval mode): stop as soon as a review returns `verdict: "approve"`. If the safety cap (20 cycles) is reached without approval, STOP and report to the user that the cap was hit.

## Guardrails

- You MUST actually call the Bash tool to run the review command. Never fabricate review output.
- You MUST actually call Edit/Write tools to fix findings. Never claim a fix without editing the file.
- After each fix phase, run `git diff --stat` and print the output so the user can see exactly which files changed.
- Print the raw review JSON verdict and finding count at each cycle: `Review {i}/{N}: verdict={verdict}, findings={count}`
- If the review command fails (non-zero exit, no JSON output, or CODEX_ROOT not found), STOP and report the error to the user. Do not proceed with fabricated results.

---

## Phase 0: Pre-check

Run `git status --porcelain`. If there are uncommitted changes:
- If `--commit` is set: log a warning that existing changes will be included in the review scope and final commit, then **proceed without prompting** (preserve non-interactive behavior).
- Otherwise: warn the user and ask:
  - **Proceed** — continue with the dirty working tree as-is
  - **Abort** — stop so the user can clean up manually and re-run

If clean, proceed silently.

---

## Phase 1: Implement

Implement the task. Write code, ensure it compiles/runs, run existing tests if applicable.
When implementation is complete, proceed to the review loop.

---

## Phase 2: Review Loop

**Fixed N mode (`--loops N`):** repeat for `i` = 1 to N.
**Until-approval mode (`--until-approval`):** repeat for `i` = 1 to 20 (safety cap), exit early on approval.

For each cycle `i`:

### Step A: Codex Review

Review command (use this exact one-liner every cycle):

```bash
CODEX_ROOT="$(find ~/.claude/plugins/marketplaces/openai-codex/plugins/codex ~/.claude/plugins/cache/openai-codex/codex -maxdepth 0 -type d 2>/dev/null | head -1)" && node "$CODEX_ROOT/scripts/codex-companion.mjs" review --wait --json
```

On the **first cycle only**, if this command fails (CODEX_ROOT empty, node error, or non-zero exit), STOP and tell the user:
> Codex is not available. Install: `npm install -g @openai/codex && codex login`
> Plugin: `/plugin install codex@openai-codex`
> Your implementation is preserved — run `/codex:review` manually when ready.

The output is JSON:
```json
{
  "verdict": "approve" | "needs-attention",
  "summary": "...",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "title": "...",
      "body": "...",
      "file": "...",
      "line_start": N,
      "line_end": N,
      "confidence": 0.0-1.0,
      "recommendation": "..."
    }
  ],
  "next_steps": ["..."]
}
```

### Step B: Fix Findings

Fix ALL findings. For each finding:
1. Read the file at the reported location
2. Understand the issue from `body` and `recommendation`
3. Apply the fix

After all findings are fixed, run tests if applicable.

If verdict was "approve" with no findings, skip Step B.

Report: `Review cycle {i}/{N}: {verdict}, {count} findings fixed` (in until-approval mode, use `{i}/≤20` instead of `{i}/{N}`)

---

## Phase 3: Update .handoff.md

Find the `.handoff.md` file in the project root (or repository root).

- If it exists: read it and update the **CURRENT STATE** section to reflect all changes made during this dev loop (what was implemented, what was fixed from reviews, any architectural changes, updated test counts if tests were added). Preserve the existing structure and style.
- If it does not exist: skip this phase silently. Do not create a new `.handoff.md`.

---

## Phase 4: Commit

If `--commit` flag was set: commit directly without asking.

Otherwise: ask the user ONE question — whether to commit.

If committing:
- Stage all relevant changed files
- Write a concise commit message describing the work done
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

If user says no: stop.
