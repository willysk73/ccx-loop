---
description: "Dev loop that repeats review-fix cycles until Codex approves (or the safety cap is hit)"
argument-hint: "[--max-cycles N] [--min-severity LEVEL] [--min-confidence N] [--commit] <task description>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, TaskCreate, TaskUpdate
---

# /ccx:forever — Loop Until Approval

Fully automated development workflow: implement, then repeat Codex review-fix cycles until Codex returns `verdict: "approve"`. For a fixed N cycles, use `/ccx:loop` instead.

Raw arguments: `$ARGUMENTS`

---

## Argument Parsing

Parse the raw arguments:
- `--max-cycles N` — safety cap on the number of review-fix cycles (default: **100**; clamped to 1–100). The loop exits on first approval; the cap only fires if Codex never approves.
- `--min-severity LEVEL` — ignore findings below this severity. One of `critical|high|medium|low`. Default: `low` (fix everything). Ranking: `critical > high > medium > low`; `--min-severity medium` means fix critical/high/medium, skip low.
- `--min-confidence N` — ignore findings whose `confidence` is below `N` (0.0–1.0). Default: `0.0`.
- `--commit` — auto-commit without asking (skip the prompt), subject to the Phase 4 auto-commit gate.
- Everything else is the **task description**.

Finding identity: throughout the loop, a finding's stable key is the logical **tuple `(file, title, body)`** — compared field-by-field, not as a concatenated string. Title and body can legitimately contain `:` or other delimiters, so concatenation would collapse distinct findings; equality/lookup must treat the three fields independently (e.g. `JSON.stringify([file, title, body])` is an acceptable concrete representation). Line numbers are deliberately excluded because fixes shift them and would otherwise defeat stuck-finding detection. `body` is included as a discriminator so that multiple distinct findings sharing a generic title in the same file (e.g. two separate "Unused import" findings) do NOT share a streak counter.

Examples:
- `/ccx:forever Refactor auth middleware` → loop until approve (≤100).
- `/ccx:forever --max-cycles 10 Update error messages` → loop until approve (≤10).
- `/ccx:forever --commit --min-severity medium Tighten input validation` → loop until medium+ findings are clear, then auto-commit.

---

## Rules

- Execute all phases sequentially. Do NOT pause between phases (except the commit prompt when `--commit` is not set).
- For each cycle, partition findings into **in-scope** (severity ≥ `--min-severity` AND `confidence` ≥ `--min-confidence`) and **skipped** (the rest). Fix every in-scope finding; log skipped ones so the user sees what was filtered.
- If a review returns `verdict: "approve"` with zero in-scope findings, skip Step C and exit the loop — this is the success condition.
- **Stuck-finding detection:** keep a per-key attempt counter (key = the `(file, title, body)` tuple). If the same in-scope finding key appears in **three consecutive cycles** (two prior fix attempts both failed to satisfy Codex), STOP the loop and report it. Without this, a persistent nitpick Claude can't satisfy would burn the full cap in Codex calls.
- **Cap-hit:** if the safety cap is reached without approval, STOP and report; do NOT auto-commit.

## Guardrails

- You MUST actually call the Bash tool to run the review command. Never fabricate review output.
- You MUST actually call Edit/Write tools to fix findings. Never claim a fix without editing the file.
- After each fix phase, run `git diff --stat` and print the output so the user can see exactly which files changed.
- Print a structured cycle summary: `Review {i}/≤{cap}: verdict={verdict}, findings={total} (in-scope={inScope}, skipped={skipped}, fixed={fixed}, unresolved={unresolved})`
- If the review command fails (non-zero exit, no JSON output, or `CODEX_ROOT` not found), STOP and report to the user. Never proceed with fabricated results.
- **Fix verification:** after each Edit/Write, treat a tool error (file missing, `old_string` not unique, etc.) as `unresolved` — record it, surface it in the cycle summary, and do not silently absorb it.

---

## Phase 0: Pre-check

Run `git status --porcelain=v1 -z` and **parse it into `PRE_LOOP_PATHS`** — a plain set of repository-relative paths. Correct parsing must:
- Split records on NUL (`-z`), not newlines.
- Strip the two-character status prefix and the following space.
- For rename records (`R`/`C`), capture BOTH the old and new path halves (they're emitted as two NUL-separated fields when `-z` is used).

`PRE_LOOP_PATHS` is a set of paths; do NOT reuse raw porcelain lines as paths anywhere later.

**Hunk-granularity caveat:** `git add <path>` is file-granular. If the loop edits a file that was already in `PRE_LOOP_PATHS`, staging that file will include the user's pre-existing hunks too — porcelain status cannot separate them. The command must surface this explicitly in the commit scope summary. If strict isolation is needed, the user should abort, clean/stash their tree, and re-run.

If `PRE_LOOP_PATHS` is non-empty (dirty tree):
- If `--commit` is set: log a warning listing the pre-existing paths, flag that any overlap with files Claude edits will be committed together, then **proceed without prompting**.
- Otherwise: warn and ask **Proceed** / **Abort**.

Do NOT probe Codex here — Phase 1 should still run even if Codex is unavailable. The first review cycle surfaces "Codex unavailable" and preserves the implementation. Each Bash tool call runs in a fresh shell, so `CODEX_ROOT` is resolved inline in Phase 2's review one-liner.

If the working tree is clean, proceed silently.

---

## Phase 1: Implement

Implement the task. Write code, ensure it compiles/runs.

**Test gate:** if the project has a test runner and the task touches code under test, run the relevant tests before entering the review loop. If tests fail, fix them first — Codex review is more expensive than a local test run, and broken builds inflate finding counts (and, in this command, risk burning cap).

When implementation compiles and tests pass (or no tests apply), proceed to the review loop.

---

## Phase 2: Review Loop

Repeat up to `cap = --max-cycles` (default 100). Maintain a `findingStreak` map across cycles, keyed by the `(file, title, body)` tuple, counting how many consecutive cycles that finding has appeared in (used for stuck-finding detection).

For each cycle `i` (from 1 to `cap`):

### Step A: Codex Review

Use this exact one-liner every cycle (each Bash call is a fresh shell, so the path must be resolved inline):

```bash
CODEX_ROOT="$(find ~/.claude/plugins/marketplaces/openai-codex/plugins/codex ~/.claude/plugins/cache/openai-codex/codex -maxdepth 0 -type d 2>/dev/null | head -1)" && node "$CODEX_ROOT/scripts/codex-companion.mjs" review --wait --json
```

On the **first cycle only**, if `CODEX_ROOT` is empty or this command fails (no JSON, non-zero exit, or node error), STOP the entire workflow and tell the user:
> Codex is not available. Install: `npm install -g @openai/codex && codex login`
> Plugin: `/plugin install codex@openai-codex`
> Your implementation is preserved on disk — run `/codex:review` and commit manually when ready.

Do NOT proceed to Phase 3 or Phase 4 in this case: committing unreviewed changes (especially with `--commit`) would defeat the review gate. On **later cycles**, a failure is also fatal — STOP and report; partial fixes are preserved on disk but not committed.

Parse the JSON:

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

Partition findings into **in-scope** vs **skipped** using `--min-severity` and `--min-confidence`.

### Step B: Stuck-finding check

For every key in the current cycle's in-scope finding set:
- If it's in `findingStreak`, increment its count.
- Otherwise, set its count to 1.

Drop any keys from `findingStreak` that did NOT appear this cycle (streak broken).

If any key's count reaches **3**, STOP the loop and report stuck finding(s). Proceed to Phase 3 but block Phase 4 auto-commit (see Phase 4 gate).

### Step C: Fix Findings

For each in-scope finding:
1. Read the file at the reported location.
2. Understand the issue from `body` and `recommendation`.
3. Apply the fix with Edit/Write. If the tool call fails, record the finding as `unresolved`; do not claim it was fixed.

After all fixes, re-run the relevant tests if applicable and record the result as `lastTestStatus` (pass / fail / n-a). A failure during non-final cycles is reported but does not abort — the next review cycle will surface the underlying issues. On the final cycle (loop about to exit), a test failure blocks Phase 4 auto-commit.

Skip Step C entirely when `verdict == "approve"` AND in-scope is empty.

### Step D: Exit checks (evaluate in this order)

1. `verdict == "approve"` AND no in-scope findings → break as **approved** (the success condition).
2. No in-scope findings but `verdict != "approve"` (every finding was filtered out) → break as **filtered-unapproved**. The command's contract ("loop until Codex approves") cannot be fulfilled because filters leave nothing to fix but Codex is still unsatisfied. STOP and **block Phase 4 auto-commit** — surface the skipped findings and require the user to rerun with adjusted filters or commit manually.
3. `i == cap` → break with **cap-hit** notice; **block Phase 4 auto-commit**.
4. Otherwise continue to cycle `i+1`. Any `unresolved` findings this cycle do not short-circuit — the next review will re-surface them.

---

## Phase 3: Update .handoff.md

Find the `.handoff.md` file in the project root (or repository root).

- If it exists: read it and update the **CURRENT STATE** section to reflect changes made during this dev loop (what was implemented, what was fixed from reviews, any architectural changes, updated test counts if tests were added, any unresolved findings / stuck-loop exits / cap-hits). Preserve the existing structure and style.
- If it does not exist: skip this phase silently. Do not create a new `.handoff.md`.

---

## Phase 4: Commit

**Auto-commit gate:** `--commit` only auto-commits when ALL of the following are true:
- Loop exited via approval (Step D rule 1). Filtered-unapproved and cap-hit exits never auto-commit.
- Final cycle had `unresolved == 0`.
- `lastTestStatus` is `pass` or `n-a` (never `fail`).
- No stuck-finding exit occurred.

For every other exit state — stuck-finding exit, filtered-unapproved, cap-hit, final-cycle `unresolved > 0`, or final-cycle test failure — `--commit` is downgraded to an interactive prompt. The final report must list what remains unresolved / unapproved / failing so the user can decide.

If `--commit` applies after the gate: commit directly without asking.
Otherwise: ask the user ONE question — whether to commit.

If committing:
- Track `EDITED_PATHS` throughout the loop: the set of file paths Claude **intentionally** created, modified, renamed, or deleted. This includes:
  - Every target of an Edit or Write tool call (Phase 1 implementation and every Phase 2 Step C fix).
  - Every path touched by intentional Bash file operations the agent runs: `mv` (both source and destination), `rm` / `git rm`, `cp` destinations, `touch`, code generators, formatters that rewrite files (`prettier --write`, `ruff format`, etc.), and any scripted codemod.
  - Build this set incrementally as each tool call executes — do NOT derive it from `git status` at the end.
- Paths changed as a side-effect of a command (e.g. test runner writing `.coverage/`, a build step producing `dist/`) must NOT be added to `EDITED_PATHS` unless the task itself was to regenerate those artifacts.
- Staging set = `EDITED_PATHS ∪ PRE_LOOP_PATHS` (when the user accepted pre-existing changes in Phase 0). Both are plain path sets — stage them with explicit `git add -- <path>` calls. Note both sets in the commit message so the scope is auditable, and note the hunk-granularity caveat for any path in `EDITED_PATHS ∩ PRE_LOOP_PATHS`.
- Never use `git add -A` or `git add .` — stage explicit paths only, so untracked generated files and editor swap files never slip in.
- Write a concise commit message describing the task and summarizing any significant findings fixed.
- Include `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.

If the user says no: stop.
