---
description: "Orchestrate N parallel /ccx:loop workers from BOARD.md — M1: dispatch + naive merge"
argument-hint: "[--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--dry-run]"
allowed-tools: Bash, BashOutput, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate
---

# /ccx:supervisor — Parallel Worker Orchestrator (M1)

One human drives N parallel `/ccx:loop` workers from a shared `BOARD.md`. Each task runs in its own git worktree, gets its own brief file, and merges back into the integration branch on approval.

Raw arguments: `$ARGUMENTS`

**M1 scope — dispatch only.** Supervisor reads `BOARD.md`, writes `.ccx/tasks/T-<id>.md` briefs, spawns workers in parallel via `claude -p`, polls for exit, attempts a naive `--no-ff` merge on approved exit, and updates `BOARD.md`. Explicitly out of M1 (see §13 of `docs/supervisor-design.md`):

- Socket/broker escalation of `chat_ask` from workers (M2). Workers dispatched by M1 still run with `--chat`, so their `chat_ask` reaches Discord directly — a human answers there, not the supervisor.
- Autonomous answering from brief `## Decisions` / BOARD direction (M3).
- Scope-glob overlap detection (M4). If two dispatched tasks touch the same files, merges may conflict; M1 catches the conflict at merge time and marks the task `blocked`, but does not pre-filter dispatch.
- Pre-merge conflict dry-run (M4).
- Supervisor-session resume after close (stretch).

SSOT for all design decisions: `docs/supervisor-design.md`. Read it before editing this command.

---

## Argument Parsing

- `--parallel N` — max concurrent workers. Default: `3`. Clamp `1..10`.
- `--integration BRANCH` — branch merges land on. Default: the supervisor's current branch. Must exist locally.
- `--max-tasks M` — stop accepting new dispatches after M successful merges. Currently-running workers still complete. Default: unlimited.
- `--worker-loops N` — value passed to each worker's `/ccx:loop --loops N`. Default: `5`. Clamp `1..20`. Tuning knob — see §14 of the design doc (open question on worker budget). `/ccx:loop` is used instead of `/ccx:forever` so every worker has a natural token cap.
- `--dry-run` — parse `BOARD.md`, print the dispatch plan, then exit without writing briefs, committing, or spawning workers.

No free-form task description — the supervisor drives entirely from `BOARD.md`. If positional text is supplied, log a warning and ignore it.

---

## Guardrails

- The supervisor MUST NOT push, force-push, amend published commits, `git reset --hard`, or `git branch -D` anything.
- Every `claude -p` worker spawn MUST use `Bash(run_in_background=true)` so the supervisor keeps control. Synchronous spawns would block the whole scheduling loop.
- Worker log files land at `.ccx/workers/<TASK_ID>.log`; the directory MUST exist before any spawn.
- The supervisor MUST NOT mark a task `merged` in `BOARD.md` without first verifying the merge actually moved `HEAD` on the integration branch (`git rev-parse HEAD` changed).
- `BOARD.md` writes are **read → modify → write** — never append-only, never via `sed`, never `git add -A`.
- Briefs are supervisor-owned. Workers MUST NOT edit `.ccx/tasks/*.md` or `BOARD.md`; the dispatch prompt states this and the supervisor does not re-read briefs from worktrees after dispatch.

---

## Phase P0: Pre-check

1. Resolve repo root: `REPO_ROOT="$(git rev-parse --show-toplevel)"`. All subsequent supervisor paths are absolute under `REPO_ROOT`.
2. Resolve integration branch:
   - If `--integration` is set, use that. Verify with `git rev-parse --verify "refs/heads/<branch>"`. Stop if missing.
   - Otherwise `INTEGRATION="$(git rev-parse --abbrev-ref HEAD)"`. If the result is `HEAD` (detached), STOP — tell the user to check out a branch first.
2a. **Integration branch must be the current checkout.** Compute `CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"`. If `CURRENT_BRANCH != INTEGRATION`, STOP with: `supervisor must be run while checked out on the integration branch — run 'git checkout <INTEGRATION>' first`. Rationale: every subsequent `git add`/`git commit`/`git merge` operates on the current `HEAD`, and worker worktrees fork from that `HEAD` too. If supervisor ran from a different branch, briefs and merges would land on the wrong branch and workers would fork from stale commits. Auto-checkout is avoided in M1 because it would require crash-safe restore on failure; forcing an explicit checkout gates the risk clearly.
3. Verify the working tree is clean on the current checkout: `git status --porcelain=v1 -z` must be empty. If dirty, STOP. Unlike `/ccx:loop`, supervisor commits land directly on the integration branch; pre-existing uncommitted changes would contaminate the dispatch/batch commits. Tell the user to stash or commit first and re-run.
4. Verify `REPO_ROOT/BOARD.md` exists. If missing, STOP and point at `docs/supervisor-design.md` §5.
5. Create (do NOT fail if present):
   - `REPO_ROOT/.ccx/tasks/`
   - `REPO_ROOT/.ccx/workers/`
6. Verify `claude` CLI is on `$PATH`: `command -v claude`. If missing, STOP — the supervisor cannot spawn workers.
7. Check `~/.claude/ccx-chat/config.json`. If missing, WARN (workers with `--chat` will disable chat per `/ccx:loop` Phase 0.7 contract — the supervisor still works, but worker `chat_ask` calls will fall back to `AskUserQuestion` which in `-p` mode aborts the worker cleanly). Do not stop.

If anything fails, print the exact error and stop. No partial setup.

---

## Phase P1: Parse BOARD.md and plan

1. Read `REPO_ROOT/BOARD.md`. Extract:
   - The `## Direction` section (everything from the line after `## Direction` up to the next `## ` heading or EOF). Store as `DIRECTION_TEXT`. May be empty.
   - The single YAML fenced code block under `## Tasks`. Parse it as a YAML array. If parsing fails or multiple fenced blocks appear under `## Tasks`, STOP with the parse error.
2. Validate each task entry. **Required** fields: `id` (string matching `^T-[0-9]+$`), `title` (non-empty string), `status` (one of `pending | assigned | review | merged | blocked`), `scope.include` (non-empty array of strings). **Optional** with defaults: `scope.exclude` (`[]`), `priority` (`normal`, one of `high | normal | low`), `depends_on` (`[]`, array of task ids), `brief` (`.ccx/tasks/<id>.md`), `notes` (`""`). If any task fails validation, STOP and print the offending row(s) verbatim.
3. Compute the two dispatch pools. Both are re-evaluated across the whole run (see P2 Step A1), so treat them as live views rather than frozen snapshots:
   - `PENDING_POOL` — every task with `status == "pending"`. Stays in this pool until the supervisor picks it up.
   - `NOT_READY_REASONS` — for each pending task whose `depends_on` contains any non-`merged` entry, record the unmet deps (for reporting). This is derivation, not filtering.
   Tasks with `status in {assigned, review, blocked, merged}` are excluded from dispatch entirely.
4. Compute the **initial ready set** `READY` — every task in `PENDING_POOL` whose `depends_on` all resolve to `status == "merged"`. Sort by `priority` descending (`high > normal > low`), breaking ties by `id` ascending treated as a numeric suffix (`T-9` < `T-10`). This ordering is re-applied every time the ready set is recomputed.
5. Print the dispatch plan:
   - `READY` — dispatchable now.
   - `NOT_READY` — waiting on listed deps; will be re-evaluated after each merge.
   - `BLOCKED` / `ASSIGNED` / `REVIEW` — present for visibility; supervisor does not touch these in M1.
6. If `--dry-run`, stop here.
7. Otherwise call `AskUserQuestion`: "Proceed with dispatch plan?" with options **Proceed** / **Abort**. On Abort, stop with no side effects.

---

## Phase P2: Scheduling loop

State:

- `SLOTS = --parallel N`
- `RUNNING = {}` — map `task_id -> { shell_id, worktree_path, branch, log_path, started_at }`
- `MERGED_COUNT = 0`
- `MERGED_IDS = []`, `BLOCKED_IDS = []`
- `PENDING_POOL` and `READY` from P1 — treated as live views; recomputed after every completion (see A1 below).

**Exit conditions** (evaluated at the top of every iteration, after A1 recomputes `READY`):

1. `RUNNING == {}` AND `READY == []` → exit. Nothing is running and nothing can be dispatched right now. Any task still in `PENDING_POOL` must have unmet deps that point at `blocked` (or non-existent) tasks, so no future completion will unblock them in this run. Report those as stranded in P3.
2. `--max-tasks M` is set AND `MERGED_COUNT >= M` AND `RUNNING == {}` → exit. Cap reached and no workers left to drain.

Without BOTH conditions the loop can hang — condition 1 covers dependency-blocked stranding, condition 2 covers cap-reached-but-pending-tasks-left. `PENDING_POOL` becoming empty is also an implicit exit because it forces `READY == []` in A1, which triggers condition 1 once `RUNNING` drains.

**Pool-removal rule.** Every time a task is classified `blocked` — whether pre-dispatch (stale-artifact / spawn-failure) or post-completion (no-commit / error / merge-conflict) — it MUST be removed from `PENDING_POOL` in the same step. Otherwise A1 would re-select it on the next pass and the same failure handler would fire indefinitely. The rule is: "blocked → out of the pool, into `BLOCKED_IDS` for the P2 Step D batch commit".

### Step A — Fill slots

A1. **Recompute `READY` first.** Iterate `PENDING_POOL`; re-include any task whose `depends_on` set is now entirely `merged` in the current in-memory BOARD state (picks up newly-unblocked tasks after each merge). Re-apply the priority + id sort. This recomputation is cheap and MUST run at the top of every Step A pass — computing `READY` only once in P1 would strand tasks whose deps merge mid-run.

A2. While `len(RUNNING) < SLOTS` AND `READY` is non-empty AND (`--max-tasks` unset OR `MERGED_COUNT < M`):

1. Pop the highest-priority ready task. Call it `TASK`. Remove it from `PENDING_POOL` only after step 7 confirms a live worker — until then, the task is still "pending" from the persisted-BOARD perspective.
1a. **Stale-branch / stale-worktree gate.** Before writing anything, verify that neither the target branch nor the target worktree path exists yet:
   ```bash
   git rev-parse --verify "refs/heads/ccx/<TASK.id>" 2>/dev/null   # expect non-zero
   test -e "<REPO_ROOT>-<TASK.id>"                                 # expect non-zero
   ```
   If either check passes (the ref or path exists), this is a stale artifact from a prior failed run. `/ccx:loop --worktree=<NAME>` responds by appending a random suffix to the branch name (see loop.md Phase 0.5 step 4); if that happens, the worker will commit on `ccx/<TASK.id>-<suffix>` while Step B polls `ccx/<TASK.id>` and misclassifies a successful run as `no-commit`. Do NOT let the worker pick its own suffix. Instead:
   - Record an in-memory BOARD update: `status: "blocked"`, `exit_status: "stale-artifact"`, `notes: "existing branch ccx/<TASK.id> or worktree <path> from prior run — delete with 'git branch -d ccx/<TASK.id>' and 'git worktree remove <path>' then re-run supervisor"`.
   - Append `<TASK.id>` to `BLOCKED_IDS` (step D persists it).
   - **Remove `<TASK.id>` from `PENDING_POOL`** per the pool-removal rule — without this, the next A1 recompute would re-include this task (because the in-memory BOARD status hasn't been persisted yet) and the same stale-artifact handler would fire on every pass indefinitely.
   - Continue the outer slot-fill loop (this slot becomes free for the next ready task).
2. **Write the brief** at `REPO_ROOT/.ccx/tasks/<TASK.id>.md` using the template in §P2.1. Frontmatter fields come from the BOARD row; body placeholders reference `DIRECTION_TEXT` and any `TASK.notes`.
3. **Commit the brief alone** on the integration branch (so the worker's worktree, which forks from the latest `HEAD`, contains the file for the 4KB-escape-hatch variant of the dispatch prompt):
   - `git add -- .ccx/tasks/<TASK.id>.md`
   - `git commit -m "supervisor: prepare <TASK.id> <TASK.title> — brief"`
   - If the commit fails (pre-commit hook, etc.), STOP the whole run and report — the brief file stays on disk but uncommitted; the task stays `pending`.
4. **Spawn the worker** with `Bash(run_in_background=true)`:

   ```bash
   cd "<REPO_ROOT>" && claude -p \
     --permission-mode bypassPermissions \
     --no-session-persistence \
     --output-format stream-json \
     "$DISPATCH_PROMPT" \
     > ".ccx/workers/<TASK.id>.log" 2>&1
   ```

   Build `DISPATCH_PROMPT` per §P2.2. Use a shell heredoc into a variable so embedded newlines and `<` characters survive unquoted:

   ```bash
   DISPATCH_PROMPT="$(cat <<'CCXPROMPT'
   ...content...
   CCXPROMPT
   )"
   ```

   Record the returned shell id as `SHELL_ID`.

5. **Verify the spawn is live** before persisting any `assigned` state — committing `status: "assigned"` to BOARD when the worker never actually started would strand the task, because future supervisor runs exclude `assigned` rows from dispatch. Two-step check:
   - Sleep 3 seconds (`sleep 3`) to let `claude -p` get past initial argv parsing and config load.
   - Use `BashOutput` on `SHELL_ID`. If the shell has already terminated AND its exit status is non-zero (or log is empty + exited), treat as **spawn failure**:
     - Do NOT commit an `assigned` BOARD update.
     - Record an in-memory BOARD update: `status: "blocked"`, `exit_status: "spawn-error"`, `notes: "claude -p exited immediately — see .ccx/workers/<TASK.id>.log"`.
     - Append `<TASK.id>` to `BLOCKED_IDS` (step D persists it).
     - Continue the outer slot-fill loop; do not spawn a replacement in the same pass.
     - **Remove `<TASK.id>` from `PENDING_POOL`** per the pool-removal rule — the in-memory BOARD is now `blocked` but not yet persisted, so A1 would otherwise re-select this task and re-attempt the spawn.
   - Otherwise the shell is running (or completed with exit 0 — exceedingly unlikely for a Codex-gated worker in 3 seconds, but also not a failure). Proceed.
6. **Persist the `assigned` state** on the integration branch:
   - In-memory edit: set the BOARD row's `status: "assigned"`, `worktree: "<REPO_ROOT>-<TASK.id>"`, `branch: "ccx/<TASK.id>"`, `started_at: "<UTC now ISO 8601>"`. Edit must be read-YAML-block → modify in memory → re-emit → replace the exact YAML block. Preserve sibling rows byte-for-byte.
   - `git add -- BOARD.md` and `git commit -m "supervisor: dispatch <TASK.id> <TASK.title>"`.
   - If this commit fails, the worker is already running — log the error, leave the worker alone (it will eventually finish and be picked up by Step B), and STOP the whole run. Do NOT kill the worker; its log and branch are preserved for manual recovery.
7. Write `RUNNING[TASK.id] = { shell_id: SHELL_ID, worktree_path: "<REPO_ROOT>-<TASK.id>", branch: "ccx/<TASK.id>", log_path: ".ccx/workers/<TASK.id>.log", started_at }`. Remove `<TASK.id>` from `PENDING_POOL`.
8. Print a one-line dispatch notice: `dispatched <TASK.id> (<TASK.title>) → shell <SHELL_ID>, log <log_path>`.

### Step B — Drain completions

For each `(task_id, meta)` in `RUNNING`:

1. Check the background shell status (via `BashOutput` on `meta.shell_id` — inspect whether the shell has terminated and its exit code). If still running, skip this task.
2. If exited, classify the outcome using two repo-state signals (the M1 subset of §4.3 — no broker state is read because the supervisor adapter does not exist yet):

   ```bash
   git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null
   git log "<INTEGRATION>..refs/heads/ccx/<task_id>" --format=%H | head -1
   ```

   - **approved** — exit code 0 AND at least one new commit on `ccx/<task_id>` relative to `INTEGRATION`.
   - **no-commit** — exit code 0 but no new commits. Worker exited via filtered-unapproved, stuck, cap-hit, or user cancellation — `/ccx:loop`'s Phase 4 auto-commit gate correctly blocked the commit. Mark `blocked`.
   - **error** — non-zero exit code (crash, invalid args, missing `claude -p`). Mark `blocked`.

3. For **approved**, attempt a naive merge onto the integration branch:

   ```bash
   git merge --no-ff --no-edit "ccx/<task_id>"
   ```

   - On success (exit 0 AND `HEAD` moved): `MERGED_COUNT += 1`, append `task_id` to `MERGED_IDS`, stash a BOARD-row update in memory: `status: "merged"`, `finished_at: "<now>"`, `exit_status: "approved"`. Do NOT commit BOARD yet — step D batches all BOARD updates into one commit.
   - On conflict: capture the conflicted file list **before** aborting — once `git merge --abort` runs, the unmerged index is gone and `git diff --name-only --diff-filter=U` returns empty. Order of operations:
     ```bash
     CONFLICT_FILES="$(git diff --name-only --diff-filter=U)"
     git merge --abort
     ```
     Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-conflict"`, `notes: "conflict on <CONFLICT_FILES, comma-separated>"`. The worker branch stays intact — the human resolves manually.

4. For **no-commit** / **error**: append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "no-commit"` or `"error"`, `notes: "see .ccx/workers/<task_id>.log"`. (`PENDING_POOL` already has this task removed from Step A step 7; the pool-removal rule requires nothing further here.)

5. Remove `task_id` from `RUNNING`.
6. Print a one-line completion notice summarizing outcome + duration + log path.

### Step C — Sleep and repeat

Sleep 3 seconds (`sleep 3`). Go back to the top of the iteration — **re-evaluate the two exit conditions first** (after A1 recomputes `READY`), then run Step A if neither condition fires. A1 is where newly-unblocked dependents get picked up by a fresh merge. This iteration shape guarantees the loop cannot spin when either (a) all remaining pending tasks depend on `blocked` predecessors (condition 1 fires once `RUNNING` drains) or (b) `--max-tasks` has been reached with tasks still pending (condition 2 fires once `RUNNING` drains).

### Step D — Batch BOARD.md commit

After the loop exits, apply all stashed BOARD-row updates to `BOARD.md` in one edit pass, then:

```bash
git add -- BOARD.md
git commit -m "supervisor: update board — merged <MERGED_IDS>, blocked <BLOCKED_IDS>"
```

If neither list changed anything, skip the commit silently (no-op run). This single batch commit replaces per-task BOARD updates to keep the integration history clean (see §10 of the design doc).

### P2.1 — Brief template

Write exactly this content to `REPO_ROOT/.ccx/tasks/<TASK.id>.md`. The 6 H2 sections MUST appear in this order — parsing downstream is schema-driven (§6.2). Substitute placeholders in `{{…}}`.

```markdown
---
id: {{TASK.id}}
title: {{TASK.title | yaml-quote}}
scope:
  include:
{{- each TASK.scope.include as glob}}
    - {{glob}}
{{- end}}
  exclude:
{{- if TASK.scope.exclude is empty}}
    []
{{- else}}
{{- each TASK.scope.exclude as glob}}
    - {{glob}}
{{- end}}
{{- end}}
depends_on: {{TASK.depends_on as YAML inline array}}
---

# {{TASK.title}}

## Goal

{{if TASK.notes is non-empty}}
{{TASK.notes}}
{{else}}
_Goal unspecified in BOARD.md. Worker should chat_ask if the intent is
not derivable from scope and project direction._
{{end}}

## Acceptance

- [ ] Code compiles and any existing tests pass.
- [ ] Changes are limited to paths matching `scope.include` and NOT matching `scope.exclude`.
- [ ] Codex review returns `verdict: "approve"` with zero in-scope findings at the worker's `--min-severity`.

## Context

Source: `BOARD.md`. Project direction at dispatch time:

> {{DIRECTION_TEXT, each line prefixed with `> `, or `_No direction set._` if empty}}

Scope globs (hard constraint — do NOT edit outside):
- include: {{TASK.scope.include}}
- exclude: {{TASK.scope.exclude}}

## Out of scope

- Any file outside the scope globs above.
- Pushing to remote, opening PRs, or creating tags.
- Modifying `BOARD.md` or any `.ccx/tasks/*.md` — those are supervisor-owned.

## Test plan

If the repo has a test runner, run it and verify no regressions. `/ccx:loop` Phase 1 enforces this automatically via its test gate.

## Decisions

_Supervisor-M1: no autonomous answering yet. This section is a placeholder — the supervisor will populate it in M3 from past merges and BOARD direction. Until then, ambiguity resolves via `chat_ask` → Discord → human._
```

### P2.2 — Dispatch prompt shape

`DISPATCH_PROMPT` is a single string containing:

```
/ccx:loop --loops <WORKER_LOOPS> --worktree=<TASK.id> --commit --chat

<task_brief path=".ccx/tasks/<TASK.id>.md" id="<TASK.id>">
{{full contents of the brief file just written in P2.A step 2}}
</task_brief>

<project_direction source="BOARD.md">
{{DIRECTION_TEXT verbatim, or `_No direction set._` if empty}}
</project_direction>

<instructions>
Read <task_brief> as your complete spec. Implement exactly what its
Acceptance section requires, respect Out of scope, and verify with
the Test plan before handing off to Codex review.

Do not edit files outside <task_brief>.scope.include. If you need to,
STOP via chat_close({status: "aborted"}) and explain why in the
worker log — the supervisor will surface the log path on exit.

When something is ambiguous and not covered by the Decisions section
of the brief, call chat_ask with the specific question. In M1 the
answer comes directly from a human on Discord (supervisor does not
intercept yet).
</instructions>
```

**Brief-size escape hatch (§7.2 of the design doc).** If `wc -c < .ccx/tasks/<TASK.id>.md` > 4096, replace the inline `<task_brief>` body with:

```
<task_brief path=".ccx/tasks/<TASK.id>.md" id="<TASK.id>">
Brief exceeds 4KB — read the file from the worktree. It is committed
at dispatch time and therefore present at the worktree fork point.
</task_brief>
```

The worker reads the brief via `Read` in its Phase 1. Because the supervisor commits the brief to `INTEGRATION` before spawning, `git worktree add … <INTEGRATION_HEAD>` includes it.

---

## Phase P3: Report

Print a structured final summary:

- **Merged** (`<count>`): list `T-<id>` — `<title>` — `<duration>`.
- **Blocked** (`<count>`): list `T-<id>` — `<exit_status>` — log path (`.ccx/workers/T-<id>.log`). Blocked reasons: `merge-conflict | no-commit | error`.
- **Not ready (deps unmet)**: list `T-<id>` with its pending deps.
- **Still assigned/running** — only non-empty if the loop exited via `--max-tasks` while workers were still running. In M1 this shouldn't happen because Step C waits on RUNNING, but guard against it in the report.

For each merged task, print the exact cleanup commands so the user can run them when ready:

```
git worktree remove "<REPO_ROOT>-T-<id>"
git branch -d "ccx/T-<id>"
```

Supervisor does NOT run these — the human decides when to clean up, matching `/ccx:loop`'s existing contract (§10).

Print a final BOARD.md snapshot (the `## Tasks` YAML block) so the user can see the end state at a glance.

---

## What's deferred to later milestones

| Feature | Milestone |
|---------|-----------|
| Broker supervisor adapter (worker `chat_ask` interception) | M2 |
| Autonomous answering from brief `## Decisions` / BOARD direction | M3 |
| Scope-glob overlap parallelism gate | M4 |
| Pre-merge conflict dry-run before committing the merge | M4 |
| Stuck-exit auto-revise brief and re-dispatch | M5 |
| Supervisor resume after session close | open |
| Worker budget cap tuning (`--worker-loops` default) | §14 of design doc |

Do not add any of these features to M1. The M1 contract is: `BOARD.md` → briefs → dispatch → poll → naive merge → BOARD update.
