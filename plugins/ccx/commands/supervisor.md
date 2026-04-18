---
description: "Orchestrate N parallel /ccx:loop workers from BOARD.md — M5: dispatch + autonomous chat_ask + scope-overlap gate + pre-merge dry-run + stuck-exit auto-revise"
argument-hint: "[--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--dry-run]"
allowed-tools: Bash, BashOutput, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, mcp__ccx-chat__chat_supervisor_poll, mcp__ccx-chat__chat_supervisor_reply, mcp__ccx-chat__chat_supervisor_escalate, mcp__ccx-chat__chat_supervisor_close, mcp__ccx-chat__chat_supervisor_recent_closures
---

# /ccx:supervisor — Parallel Worker Orchestrator (M5)

One human drives N parallel `/ccx:loop` workers from a shared `BOARD.md`. Each task runs in its own git worktree, gets its own brief file, and merges back into the integration branch on approval. Worker `chat_ask` calls are intercepted by the broker; the supervisor session answers from the brief / BOARD / merge history when possible, escalating to Discord only when no deterministic answer fits. Tasks whose scope globs touch overlapping files are serialized at dispatch time so concurrent worktrees do not produce conflicting merges, and every merge is staged via a `--no-commit` dry-run before it is finalized. When a worker exits via stuck-finding detection, the supervisor prompts the human once for guidance, appends that guidance to the brief's `## Decisions` section, and re-dispatches the same task one time before giving up.

Raw arguments: `$ARGUMENTS`

**Milestones shipped** (see §13 of `docs/supervisor-design.md`):

- **M1 — dispatch.** `BOARD.md` → briefs → `claude -p` workers → naive `--no-ff` merge → batch BOARD update.
- **M2 — broker supervisor adapter.** `backend: "supervisor"` in `~/.claude/ccx-chat/config.json` queues worker asks in the broker and exposes `chat_supervisor_{poll,reply,escalate,close}` MCP tools, with a per-ask auto-escalate timer as the no-supervisor-session fallback.
- **M3 — autonomous answering.** `/ccx:supervisor` polls the broker's supervisor queue every scheduling iteration. For each pending ask it consults the task brief's `## Decisions` table, BOARD `## Direction`, and the integration branch's merge-commit history. A confident deterministic match → `chat_supervisor_reply`; otherwise → `chat_supervisor_escalate` (human answers on Discord). Every supervisor decision is appended as JSONL to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can audit after the fact.
- **M4 — scope-overlap gate + pre-merge dry-run.** Step A defers any pending task whose `scope.include` matches a tracked file already claimed by a `RUNNING` task — overlap is computed by intersecting the two `git ls-files -- <pathspecs>` results plus a literal-glob equality fallback for globs that match no current files. Deferred tasks stay in `PENDING_POOL` and are retried next iteration when slots free; nothing is marked `blocked`. Step B's merge stages the integration branch via `git merge --no-commit --no-ff --no-edit`, inspects unmerged paths, and either finalizes with `git commit --no-edit` (clean) or `git merge --abort` (conflict) — separating conflict detection from commit creation.
- **M5 — stuck-exit auto-revise + re-dispatch (this milestone).** Worker `chat_close({status: "stuck"})` is now recoverable in bounded cases. The broker records every `chat_close` status in an in-memory ring buffer (`chat_supervisor_recent_closures` MCP tool); Step B queries it after a `no-commit` classification to peel off stuck exits from the broader cap-hit / filtered-clean / aborted bucket. On the first stuck exit per task, the supervisor prompts the human (via `AskUserQuestion`) with the stuck-finding details tailed from the worker log and offers three outcomes — re-dispatch with guidance, re-dispatch unchanged, or abort. Re-dispatch with guidance appends the human's text to the brief's `## Decisions` section, commits the revised brief, cleans the prior worktree+branch, and re-spawns the worker; the BOARD row's `attempts` counter increments. A second stuck exit on the same task classifies as `stuck-exhausted` and blocks without prompting — one re-dispatch is the hard cap. See §P2.5.

Still deferred (out of scope for M5):

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
- Every M3 supervisor decision (autonomous reply or escalation — close is not used by M3; see Step B2 step c) MUST be appended to `REPO_ROOT/.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` immediately after the broker tool call returns — logging AFTER the call captures the real broker outcome (`ok: true` vs `ok: false` when the ask was already resolved by the auto-escalate timer or session cancel). An in-memory decision the human cannot audit defeats the point of M3.
- The supervisor MUST NOT `chat_supervisor_reply` with information it could not itself cite back to a brief decision / BOARD direction / merge commit. "Best guess from general reasoning" is NEVER a confident match — escalate instead. Autonomous answering is an optimization, not a replacement for the human judgement call.

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
   - `REPO_ROOT/.ccx/supervisor-audit/` (per-run M3 audit-log directory; empty until Step B2 writes anything)
5a. **Compute a per-run supervisor ID** `SUPERVISOR_RUN_ID = <UTC-compact-ts>-<rand8>` (e.g. `20260417T153012Z-a3f9c011`). Per-run isolation is required because two concurrent `/ccx:supervisor` runs on the same host each own their own DISPATCHED set but share `REPO_ROOT` — writing both runs' decisions into a single `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` would let either run's Step D commit pick up the other's audit entries. Use `SUPERVISOR_RUN_ID` as the audit filename (Step B2 writes `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`; Step D only stages that exact file; P3 reads that exact file). Do not reuse a prior run's ID.
6. Verify `claude` CLI is on `$PATH`: `command -v claude`. If missing, STOP — the supervisor cannot spawn workers.
7. Check `~/.claude/ccx-chat/config.json`. If missing, WARN (workers with `--chat` will disable chat per `/ccx:loop` Phase 0.7 contract — the supervisor still works, but worker `chat_ask` calls will fall back to `AskUserQuestion` which in `-p` mode aborts the worker cleanly). Do not stop.

If anything fails, print the exact error and stop. No partial setup.

---

## Phase P1: Parse BOARD.md and plan

1. Read `REPO_ROOT/BOARD.md`. Extract:
   - The `## Direction` section (everything from the line after `## Direction` up to the next `## ` heading or EOF). Store as `DIRECTION_TEXT`. May be empty.
   - The single YAML fenced code block under `## Tasks`. Parse it as a YAML array. If parsing fails or multiple fenced blocks appear under `## Tasks`, STOP with the parse error.
2. Validate each task entry. **Required** fields: `id` (string matching `^T-[0-9]+$`), `title` (non-empty string), `status` (one of `pending | assigned | review | merged | blocked`), `scope.include` (non-empty array of strings). **Optional** with defaults: `scope.exclude` (`[]`), `priority` (`normal`, one of `high | normal | low`), `depends_on` (`[]`, array of task ids), `brief` (`.ccx/tasks/<id>.md`), `notes` (`""`), `attempts` (`0`, non-negative integer — supervisor-managed counter used by M5 stuck recovery; humans never need to set this, but a missing or null field must be accepted and normalized to `0` so existing BOARDs authored before M5 continue to parse).

   **Glob-string contract** (used by M4's overlap gate, §P2.4): every entry in `scope.include` and `scope.exclude` MUST be a non-empty string that contains no NUL byte and no newline character — those are the two characters that would break `git ls-files -z` output parsing. All other characters (including single-quote `'`, double-quote `"`, spaces, `$`, backtick) are permitted because §P2.4 mandates exec/argv invocation; single-quote in particular is a legal character in committed Git paths (e.g. `docs/engineer's-guide.md`) and rejecting it would be a regression in accepted task scopes.

   **Pathspec sanity probe** (M4 — runs at validation time, before the dispatch loop starts): for every task whose `status == "pending"`, run `git ls-files -z --` with each glob in `scope.include` AND `scope.exclude` as its own argv element (per §P2.4 step 1's contract — direct exec, no shell). The probe uses Git's pathspec parser without doing anything with the output; its sole purpose is to catch malformed pathspecs deterministically at startup. Any non-zero exit, or stderr matching `bad pathspec` / `unknown pathspec` / `pathspec '...' .* invalid`, fails this task's validation. Without this probe, malformed `:(...)` magic or a stray `\` in a pathspec would only surface inside §P2.4's overlap gate, which defers-and-retries on `git ls-files` failure — turning a bad BOARD row into an infinite supervisor loop because no exit condition fires while `READY` keeps re-including a task that can never dispatch. STOP and print every offending task id with the verbatim git stderr; the human fixes the BOARD row and re-runs.

   If any task fails validation (shape, required-field, glob-string contract, or pathspec sanity probe), STOP and print the offending row(s) verbatim.
3. Compute the two dispatch pools. Both are re-evaluated across the whole run (see P2 Step A1), so treat them as live views rather than frozen snapshots:
   - `PENDING_POOL` — every task with `status == "pending"`. Stays in this pool until the supervisor picks it up.
   - `NOT_READY_REASONS` — for each pending task whose `depends_on` contains any non-`merged` entry, record the unmet deps (for reporting). This is derivation, not filtering.
   Tasks with `status in {assigned, review, blocked, merged}` are excluded from dispatch entirely.
4. Compute the **initial ready set** `READY` — every task in `PENDING_POOL` whose `depends_on` all resolve to `status == "merged"`. Sort by `priority` descending (`high > normal > low`), breaking ties by `id` ascending treated as a numeric suffix (`T-9` < `T-10`). This ordering is re-applied every time the ready set is recomputed.
5. Print the dispatch plan:
   - `READY` — dispatchable now.
   - `NOT_READY` — waiting on listed deps; will be re-evaluated after each merge.
   - `BLOCKED` / `ASSIGNED` / `REVIEW` — present for visibility; supervisor does not touch these (they need human action or are owned by a prior/concurrent run).
6. If `--dry-run`, stop here.
7. Otherwise call `AskUserQuestion`: "Proceed with dispatch plan?" with options **Proceed** / **Abort**. On Abort, stop with no side effects.

---

## Phase P2: Scheduling loop

State:

- `SLOTS = --parallel N`
- `STUCK_REDISPATCH_CAP = 2` — hard cap on per-task dispatch attempts (M5). First dispatch counts as 1; one re-dispatch after a stuck exit is allowed; a second stuck exit blocks the task as `stuck-exhausted` without prompting. Hardcoded for M5 MVP — a CLI flag is a later tuning knob.
- `RUNNING = {}` — map `task_id -> { shell_id, worktree_path, branch, log_path, started_at, scope_include, attempts }`. `scope_include` is the BOARD row's `scope.include` glob list (a list of strings, copied verbatim at dispatch time), used by Step A's scope-overlap gate to detect which currently-running task already claims the files a candidate task would touch. `attempts` starts at `1` on first dispatch (Step A step 6) and is incremented in place by §P2.5's re-dispatch path; it is the in-memory mirror of the BOARD row's `attempts` field and is used by Step B to enforce `STUCK_REDISPATCH_CAP`.
- `DISPATCHED = set()` — every `<TASK_ID>` this supervisor has launched in this run (populated in Step A step 7, never removed). Used by Step B2's ownership filter so asks from workers that exit between ask-time and the next poll are still recognized as ours.
- `MERGED_COUNT = 0`
- `MERGED_IDS = []`, `BLOCKED_IDS = []`
- `PENDING_POOL` and `READY` from P1 — treated as live views; recomputed after every completion (see A1 below).
- `DEFERRED_THIS_PASS = set()` — Step A scratch state, cleared at the top of every Step A pass. Tracks which `READY` task ids have already been popped and deferred this pass due to scope-overlap so the inner loop does not re-pop and re-defer the same task indefinitely (popping is destructive — without this set the head of `READY` would be reconsidered until slots fill, masking lower-priority dispatchable tasks behind it).
- `EVER_DEFERRED_BY_SCOPE = set()` — run-level accumulator, NEVER cleared. A1's clear of `DEFERRED_THIS_PASS` is correct for slot-fill scheduling but discards the history P3 needs to classify leftover `PENDING_POOL` entries. Every time A2 step 1a defers a task by scope-overlap, also add its id to `EVER_DEFERRED_BY_SCOPE`. P3 reads this set to attach the `scope-deferred` reason to any task that ends the run still in `PENDING_POOL`. A task that was deferred earlier but eventually dispatched (and then merged or blocked) stays in this set, but P3 ignores it because it is no longer in `PENDING_POOL` at exit — the set is purely a tag, not a status.
- `STOP_DISPATCHING = false` — set to `true` by Step B's merge-commit-failed branch (M4) when the integration-branch commit pipeline rejects a merge commit. While `true`, Step A's slot-fill is skipped entirely so no new workers start, but Step B continues to drain `RUNNING` so already-in-flight peers are not stranded as `assigned`. Loop exit gains a new condition 3 (see below) that fires once `RUNNING` drains, because `READY` may legitimately still hold pending tasks at that point — those tasks are intentionally being left for a future supervisor run after the human resolves the broken commit pipeline.

**Exit conditions** (evaluated at the top of every iteration, after A1 recomputes `READY`):

1. `RUNNING == {}` AND `READY == []` → exit. Nothing is running and nothing can be dispatched right now. Any task still in `PENDING_POOL` must have unmet deps that point at `blocked` (or non-existent) tasks, so no future completion will unblock them in this run. Report those as stranded in P3.
2. `--max-tasks M` is set AND `MERGED_COUNT >= M` AND `RUNNING == {}` → exit. Cap reached and no workers left to drain.
3. `STOP_DISPATCHING == true` AND `RUNNING == {}` → exit. The integration-branch commit pipeline rejected a merge commit and the supervisor is in drain-then-stop mode (Step B's merge-commit-failed branch). Once the last in-flight worker has been classified by Step B, there is nothing left for the loop to do — A2 is gated off by `STOP_DISPATCHING`, so any tasks still in `PENDING_POOL` (READY or not) MUST stay there until a future supervisor run picks them up after the human fixes the broken commit pipeline. Without this condition the loop would spin forever in this scenario, because A1 keeps `READY` populated from `PENDING_POOL` even when A2 cannot act on it. Report any leftover `PENDING_POOL` entries as `deferred-by-stop-dispatching` in P3.

Without all three conditions the loop can hang — condition 1 covers dependency-blocked stranding, condition 2 covers cap-reached-but-pending-tasks-left, condition 3 covers commit-pipeline-broken-but-pending-tasks-left. `PENDING_POOL` becoming empty is also an implicit exit because it forces `READY == []` in A1, which triggers condition 1 once `RUNNING` drains.

**Pool-removal rule.** Every time a task is classified `blocked` — whether pre-dispatch (stale-artifact / spawn-failure) or post-completion (no-commit / error / merge-conflict) — it MUST be removed from `PENDING_POOL` in the same step. Otherwise A1 would re-select it on the next pass and the same failure handler would fire indefinitely. The rule is: "blocked → out of the pool, into `BLOCKED_IDS` for the P2 Step D batch commit".

### Step A — Fill slots

A1. **Recompute `READY` first.** Iterate `PENDING_POOL`; re-include any task whose `depends_on` set is now entirely `merged` in the current in-memory BOARD state (picks up newly-unblocked tasks after each merge). Re-apply the priority + id sort. This recomputation is cheap and MUST run at the top of every Step A pass — computing `READY` only once in P1 would strand tasks whose deps merge mid-run. Then **clear `DEFERRED_THIS_PASS`** so the new pass starts with a fresh deferral list (deferrals from a previous pass were instructive only for that pass — by the time A1 runs again, the `RUNNING` set has already changed via Step B drains and the overlap picture may differ). A1 always runs, even when `STOP_DISPATCHING == true`, so P3 reporting and the loop's exit condition still observe the correct `READY` state.

A2. **Skip A2 entirely when `STOP_DISPATCHING == true`** — no slot-fill, no overlap checks, no spawns. The loop relies on Step B to drain `RUNNING` until **exit condition 3** fires naturally (condition 1 cannot fire while `STOP_DISPATCHING` is set because A1 keeps `READY` populated from any leftover `PENDING_POOL` entries; condition 3 was added precisely so this path has a terminating exit). Otherwise, while `len(RUNNING) < SLOTS` AND `READY` contains at least one task NOT in `DEFERRED_THIS_PASS` AND (`--max-tasks` unset OR `MERGED_COUNT < M`):

1. Pop the highest-priority ready task that is not in `DEFERRED_THIS_PASS`. Call it `TASK`. Remove it from `PENDING_POOL` only after step 7 confirms a live worker — until then, the task is still "pending" from the persisted-BOARD perspective.
1a. **Scope-overlap gate.** Before any side effect, check whether `TASK.scope.include` overlaps with any `RUNNING_TASK.scope_include` for `RUNNING_TASK` currently in `RUNNING`. Use the algorithm in §P2.4. If any pairwise overlap is detected:
   - Add `TASK.id` to `DEFERRED_THIS_PASS` (per-pass, scoped to the inner slot-fill loop).
   - Add `TASK.id` to `EVER_DEFERRED_BY_SCOPE` (run-level, used by P3 to label leftover `PENDING_POOL` rows). Adding repeatedly is a no-op — set semantics.
   - Do NOT mark `blocked`. Do NOT remove from `PENDING_POOL`. Do NOT touch BOARD or write a brief.
   - Print one line: `deferred <TASK.id> — scope overlaps running <OVERLAP_TASK.id> on <SHARED_FILES (max 3, …)>`. Overlap is a transient parallelism gate, not a failure mode; the task is re-evaluated next iteration.
   - Continue the inner slot-fill loop (try the next non-deferred ready task). Do not advance to step 1b.
1b. **Stale-branch / stale-worktree gate.** Before writing anything, verify that neither the target branch nor the target worktree path exists yet:
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
4. **Capture `STARTED_AT` BEFORE spawning.** Record `STARTED_AT = <UTC now ISO 8601>` immediately, before the Bash spawn call below. Steps 6 and 7 MUST both use this same `STARTED_AT` value — not a re-sampled "now" timestamp. Rationale: §P2.5's stuck classifier requires `closure.at >= meta.started_at` to distinguish a fresh stuck exit from a stale closure in the broker's ring buffer. If the worker exits stuck very quickly (within the 3s liveness check, or during the `assigned` BOARD commit, or if a local config file makes `claude -p` crash fast), its `chat_close` `at` timestamp will be older than a "now" sampled at step 6 — and the classifier would filter out exactly the fast-fail stuck events M5 is meant to recover. Sampling `STARTED_AT` pre-spawn closes that window.

   Then spawn the worker with `Bash(run_in_background=true)`:

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
   - In-memory edit: set the BOARD row's `status: "assigned"`, `worktree: "<REPO_ROOT>-<TASK.id>"`, `branch: "ccx/<TASK.id>"`, `started_at: "<STARTED_AT from step 4>"`, `attempts: 1` (M5 — first dispatch counts as attempt 1; §P2.5's re-dispatch path increments on subsequent attempts). Do NOT re-sample "now" here; reuse the `STARTED_AT` captured pre-spawn so the M5 classifier window covers the entire lifetime of the worker including the 3s liveness check. Edit must be read-YAML-block → modify in memory → re-emit → replace the exact YAML block. Preserve sibling rows byte-for-byte.
   - `git add -- BOARD.md` and `git commit -m "supervisor: dispatch <TASK.id> <TASK.title>"`.
   - If this commit fails, the worker is already running — log the error, leave the worker alone (it will eventually finish and be picked up by Step B), and STOP the whole run. Do NOT kill the worker; its log and branch are preserved for manual recovery.
7. Write `RUNNING[TASK.id] = { shell_id: SHELL_ID, worktree_path: "<REPO_ROOT>-<TASK.id>", branch: "ccx/<TASK.id>", log_path: ".ccx/workers/<TASK.id>.log", started_at: STARTED_AT, scope_include: TASK.scope.include, attempts: 1 }` (reuse the SAME `STARTED_AT` captured in step 4) AND add `TASK.id` to the `DISPATCHED` set. The `scope_include` field is a verbatim copy of the BOARD row's glob list captured at dispatch time — Step A's overlap gate (§P2.4) reads it on every subsequent pass, so it MUST snapshot the value rather than re-read BOARD (a concurrent BOARD edit between dispatch and the next pass would otherwise change the overlap picture under the supervisor). The `attempts` field mirrors the BOARD row's `attempts: 1` just written in step 6; §P2.5 increments both in lockstep on re-dispatch. `DISPATCHED` is never removed from — it's the ownership source of truth for Step B2's filter across the whole run. Remove `<TASK.id>` from `PENDING_POOL`.
8. Print a one-line dispatch notice: `dispatched <TASK.id> (<TASK.title>) → shell <SHELL_ID>, log <log_path>`.

### Step B — Drain completions

For each `(task_id, meta)` in `RUNNING`:

1. Check the background shell status (via `BashOutput` on `meta.shell_id` — inspect whether the shell has terminated and its exit code). If still running, skip this task.
2. If exited, classify the outcome using two repo-state signals (the M1 subset of §4.3 — broker `chat_close` state is currently ignored because the integration-branch commit is the authoritative "approved" signal; adding `chat_close` as a cross-check is a later milestone):

   ```bash
   git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null
   git log "<INTEGRATION>..refs/heads/ccx/<task_id>" --format=%H | head -1
   ```

   - **approved** — exit code 0 AND at least one new commit on `ccx/<task_id>` relative to `INTEGRATION`.
   - **no-commit** — exit code 0 but no new commits. Worker exited via filtered-unapproved, stuck, cap-hit, or user cancellation — `/ccx:loop`'s Phase 4 auto-commit gate correctly blocked the commit. Mark `blocked`.
   - **error** — non-zero exit code (crash, invalid args, missing `claude -p`). Mark `blocked`.

3. For **approved**, attempt a **two-step pre-merge dry-run** onto the integration branch — stage the merge with `--no-commit`, inspect the index, then either finalize or abort. Splitting "test the merge" from "commit the merge" lets the supervisor reason about conflicts as a first-class outcome (and gives M5 a hook to run extra validation between stages without rewriting the merge call):

   ```bash
   if git merge --no-commit --no-ff --no-edit "ccx/<task_id>"; then
     # Dry-run reports clean — finalize using the prepared MERGE_MSG.
     git commit --no-edit
   else
     # Non-zero from --no-commit. Two sub-cases:
     #   - conflict (unmerged paths present)
     #   - non-conflict failure (refusal, branch-protection, no-merge-already-in-progress)
     # Capture unmerged paths BEFORE the abort wipes the index, then abort
     # (ignoring the abort's exit code — `git merge --abort` errors when no
     # merge is actually in progress, which is correct for the non-conflict case).
     CONFLICT_FILES="$(git diff --name-only --diff-filter=U)"
     git merge --abort 2>/dev/null || true
   fi
   ```

   Four outcomes (the third and fourth are M4 additions; the first two preserve the M3 behavior):

   - **Clean dry-run + commit succeeds** (`git merge --no-commit ...` exit 0 AND `git commit --no-edit` exit 0 AND `HEAD` moved): `MERGED_COUNT += 1`, append `task_id` to `MERGED_IDS`, stash a BOARD-row update in memory: `status: "merged"`, `finished_at: "<now>"`, `exit_status: "approved"`. Do NOT commit BOARD yet — step D batches all BOARD updates into one commit.
   - **Conflict** (`git merge --no-commit ...` exit non-zero AND `CONFLICT_FILES` non-empty): capture `CONFLICT_FILES` **before** running `git merge --abort` — once the abort runs, the unmerged index is gone and `git diff --name-only --diff-filter=U` returns empty. Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-conflict"`, `notes: "conflict on <CONFLICT_FILES, comma-separated>"`. The worker branch stays intact — the human resolves manually.
   - **Non-conflict merge refusal** (`git merge --no-commit ...` exit non-zero AND `CONFLICT_FILES` is empty): Git refused the merge for a reason other than file-level conflicts — examples include a `pre-merge-commit` hook rejecting the merge before any tree was written, a branch protection / signed-merge requirement that fails up front, an existing residual `MERGE_HEAD` from a prior failed iteration that Git refuses to overlay, or an unreachable / corrupt object on the worker branch. Some of these are **transient** (residual `MERGE_HEAD` cleared by the abort, `.git/index.lock` released by an exiting peer process, a temporary network blip while resolving the worker branch); others are **permanent** for this run (signed-merge requirement, branch-protection rule, hook that inspects merge content). The supervisor cannot reliably classify these from stderr alone, so it does **one in-iteration retry** before declaring the task permanently blocked.

     Capture the verbatim stderr from the failed `git merge --no-commit` call (call it `MERGE_STDERR_1`) before running the abort — the abort's own output overwrites Git's diagnostic if both are written to the same buffer. The unconditional `git merge --abort 2>/dev/null || true` above already cleared any residual `MERGE_HEAD`. Then attempt the merge ONCE more, immediately, in the same Step B iteration:

     ```bash
     # Single in-iteration retry. Any locks/MERGE_HEAD that the first
     # abort cleared will not block the retry; permanent rejections will
     # surface again identically.
     if git merge --no-commit --no-ff --no-edit "ccx/<task_id>"; then
       git commit --no-edit
       # Falls into the "Clean dry-run + commit succeeds" outcome.
     else
       CONFLICT_FILES_2="$(git diff --name-only --diff-filter=U)"
       MERGE_STDERR_2="<verbatim stderr of the retry's --no-commit call>"
       git merge --abort 2>/dev/null || true
       # Inspect CONFLICT_FILES_2 to decide which permanent branch to take.
     fi
     ```

     Three terminal states from the retry:
     1. **Retry succeeds** (clean merge + commit): treat exactly like the "Clean dry-run + commit succeeds" outcome above (`MERGED_COUNT += 1`, append to `MERGED_IDS`, stash `status: "merged" / exit_status: "approved"`). Do NOT add a `notes` entry mentioning the first-attempt failure — the merge is in the integration history at this point; a "we retried" note is reflog territory, not BOARD-row territory.
     2. **Retry conflicts** (`CONFLICT_FILES_2` non-empty): the first attempt's transient cause cleared, exposing a real file-level conflict. Treat exactly like the "Conflict" outcome above (`status: "blocked" / exit_status: "merge-conflict" / notes: "conflict on <CONFLICT_FILES_2, comma-separated>"`).
     3. **Retry refuses again** (`CONFLICT_FILES_2` empty AND non-zero exit): the rejection is permanent for this run. Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-aborted"`, `notes: "git merge --no-commit refused without conflicts (retried once): <first 200 chars of MERGE_STDERR_2, single-line>"`. Do NOT set `STOP_DISPATCHING` here — `merge-aborted` is per-merge, not per-supervisor; if a subsequent peer's merge also hits the same refusal, the same handler fires again and the human sees a pattern in P3. The worker branch stays intact for manual investigation.

     Why a single in-iteration retry rather than re-queuing for the next Step B iteration: re-queuing would require a new "approved-but-not-yet-merged" state alongside `RUNNING` and `BLOCKED_IDS`, which complicates exit-condition reasoning and could mask a permanent failure as "the supervisor will get to it eventually". A single immediate retry catches the specific transient causes documented above (locks released within milliseconds, `MERGE_HEAD` cleared by the abort) without inventing a new state. Failures that need more than seconds to clear are correctly classified as `merge-aborted` and surfaced for human triage.
   - **Dry-run clean but commit fails** (pre-commit hook rejects the merge, signing failure, etc.): the working tree still has `MERGE_HEAD` set and the index holds a successful merge result that was never committed. Run `git merge --abort` to restore the integration branch to its pre-merge state — leaving `MERGE_HEAD` around would make the next iteration's `git merge --no-commit` refuse with "You have not concluded your merge". Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-commit-failed"`, `notes: "merge dry-run clean but commit failed — see supervisor stderr"`. Then handle the **likely Step D commit failure** synchronously, before STOPping the run:

     The same condition that rejected the merge commit (broken pre-commit hook, signing key absent, integration-branch protection, etc.) is overwhelmingly likely to reject the Step D batch BOARD commit too. If Step D fails after the merge-commit-failed branch fires, the in-memory `status: "blocked"` update is lost from the repo — `BOARD.md` stays at `status: "assigned"`, and every future supervisor run skips this task (P1 step 3 excludes `assigned` from `PENDING_POOL`). To avoid stranding the row:

     1. **Write a recovery sidecar synchronously**, BEFORE Step D runs and BEFORE STOP:

        ```
        REPO_ROOT/.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt
        ```

        Contents (plain text, append-only, never JSON — humans read this directly):
        ```
        Run: <SUPERVISOR_RUN_ID>
        Cause: merge-commit-failed for <task_id> on integration branch <INTEGRATION>
        Last git stderr: <verbatim git commit stderr from the failed --no-edit call>

        Required manual recovery:
        1. Inspect/fix the integration-branch commit hook or signing config that rejected the merge commit.
        2. Apply this BOARD.md edit by hand (the supervisor's Step D may also fail to commit it):
           - Set BOARD row id=<task_id> status=blocked, exit_status=merge-commit-failed,
             notes="merge dry-run clean but commit failed — see <log_path>"
           - Append <task_id> to BLOCKED_IDS in any pending audit summary.
        3. Stage and commit BOARD.md once the hook accepts commits again:
             git add BOARD.md
             git commit -m "supervisor recovery: mark <task_id> blocked (merge-commit-failed)"

        Worker branch ccx/<task_id> is INTACT and contains the approved diff.
        ```

        The sidecar uses `SUPERVISOR_RUN_ID` (P0 step 5a) so concurrent supervisor recoveries don't overwrite each other. It is plain `.txt` to dodge the repo's `*.log` ignore rule and so `git status` surfaces it as untracked — the human sees it on the next interactive `git status`. The file is intentionally NOT staged or committed by the supervisor; staging it would re-trigger the same failing commit hook.

     2. **Set the run-wide `STOP_DISPATCHING = true` flag** (initialized to `false` at the start of the scheduling loop alongside `SLOTS` / `RUNNING` / `DISPATCHED`) so Step A stops popping new tasks. Do NOT stop the loop yet — other workers in `RUNNING` may already be in flight (especially likely with `--parallel > 1`), and terminating the supervisor while peers are still working would strand their BOARD rows at `status: "assigned"`, which P1 step 3 excludes from `PENDING_POOL` on every future run. The merge-commit failure is a per-merge-commit symptom — common causes are a `commit-msg` hook rejecting Git's default `Merge branch '...' into <INTEGRATION>` subject, an integration-branch protection rule that blocks merge-shaped commits specifically, or a signing key that is unavailable at the moment of the merge — none of which prevent the supervisor from continuing to **drain** existing workers via Step B. Continuing to drain has three benefits:
        - Approved peers may merge cleanly (their merges may use a slightly different subject path, or the commit-pipeline issue may be transient and resolve mid-run).
        - Peers that fail to merge for the same reason get the same treatment (block + append to the recovery sidecar), so the sidecar grows into a complete recovery list rather than reflecting just the first failure.
        - `no-commit` / `error` peers do not require any commit step at all and can be cleanly classified as `blocked` without re-tripping the broken commit pipeline.

     3. **Continue the scheduling loop.** Step A's slot-fill is gated by `STOP_DISPATCHING == true` — when set, A2 skips outright (no new pops, no new briefs, no new spawns) but A1 still runs to keep `PENDING_POOL` views consistent for P3 reporting. Step B continues draining `RUNNING` exactly as before. Step C still sleeps + iterates. The loop exits via **condition 3** (`STOP_DISPATCHING == true` AND `RUNNING == {}`) once the last in-flight worker drains. Condition 3 is required because A1 keeps `READY` populated from `PENDING_POOL` even when A2 cannot act on it, so condition 1 alone would never fire when there are untouched pending tasks left at the moment the commit pipeline broke — those tasks legitimately stay in `PENDING_POOL` for a future supervisor run to pick up after the human resolves the underlying hook/signing/protection issue.

     4. **Step D runs exactly once at natural loop exit, regardless of how many merge-commit failures accumulated.** Step D's commit subject is `supervisor: update board — merged ..., blocked ...`, which is plausibly accepted by hooks that only reject merge-shaped commits — so Step D may well succeed even when every merge attempt failed. Two outcomes:
        - **Step D succeeds.** The blocked statuses for every merge-commit-failed task are persisted on the integration branch. The sidecar is obsolete (the Step D commit subject already records every blocked id; the JSONL audit log records each supervisor decision). The supervisor MUST `rm` the sidecar (`rm -f "$REPO_ROOT/.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt"`) before exiting. Leaving it behind would make the file untracked on the integration branch and the next supervisor run would fail P0 step 3's `git status --porcelain=v1 -z` clean-tree gate, even though no manual recovery is actually needed.
        - **Step D fails.** The sidecar is the only authoritative record of every blocked status and the human-facing recovery instructions. Leave it on disk untouched — this is precisely the case the sidecar exists for; the same broken hook that blocks Step D will also block any committable cleanup, so the sidecar must persist until the human resolves the underlying issue and stages the recovery edits manually. Step D's own commit-failure-recovery clause (further below in this section) handles appending to the same file for any blocked ids that were not yet recorded.

     5. **Final P3 report** prints the absolute sidecar path when the file still exists at exit, plus a one-line summary of how many tasks blocked with `merge-commit-failed`. Omit the sidecar-path line entirely when Step D succeeded and the sidecar was deleted in step 4 above.

   The dry-run does NOT replace the abort-on-conflict guarantee — the conflict-capture order in §3 step 3 below is unchanged. The dry-run adds a bounded "clean merge prepared but not yet committed" window; that window MUST be closed by either `git commit --no-edit` or `git merge --abort` before Step B moves to the next `(task_id, meta)`. Never leave a partial merge state across loop iterations — Step B's own next iteration would observe the residual `MERGE_HEAD` and either fail to start a new merge or compound the unfinalized one.

4. For **no-commit**: check whether this was a stuck-finding exit before marking blocked.

   **M5 stuck sub-classification.** `/ccx:loop` calls `chat_close({status: "stuck"})` when stuck-finding detection fires and `chat_close({status: ...})` with other verbs (`filtered-clean`, `cap-hit`, `aborted`) for the other `no-commit` reasons. The supervisor queries the broker's recent-closures ring buffer (populated by the `close()` handler on every `chat_close` call) to distinguish these. If the closure record for `branch == "ccx/<task_id>"` shows `status == "stuck"`, hand the task to the §P2.5 stuck-recovery algorithm INSTEAD of marking blocked. Any other status — or any failure to query the buffer — falls through to the generic no-commit handling below.

   ```
   closures = try mcp__ccx-chat__chat_supervisor_recent_closures({
                cwd: meta.worktree_path,
                branch: "ccx/<task_id>",
                since: meta.started_at,
                limit: 16,
              })
              catch → skip to generic no-commit handling
   scopedClosures = closures.closures sorted by `at` ascending
   latest = last entry of scopedClosures, or null if none
   if latest != null AND latest.status == "stuck":
       hand off to §P2.5 — do NOT fall through
   else:
       fall through to generic no-commit handling below
   ```

   **Server-side filter parameters are mandatory for M5 scale.** Pass `cwd`, `branch`, and `since` as shown — do NOT call the tool with an empty params object and filter client-side. The broker's ring buffer can hold up to 8192 entries (24h of closures across every concurrent session on the host); shipping the whole buffer through MCP on every Step B `no-commit` exit would routinely exceed tool/model output budgets, at which point the supervisor's Step B query falls back to the generic no-commit path and M5 silently stops working on realistic workloads. The broker applies these filters identically to the client-side rules described in "Three-dimension scoping" below, so the returned `closures` list is already scoped to this worker's attempt — the supervisor only needs to sort by `at` and pick the tail entry. `limit: 16` is generous for the single-worker single-attempt case (one expected entry) while still tolerating any transient over-reporting.

   **Three-dimension scoping (all required).** The closure ring buffer is broker-wide — shared across every `/ccx:supervisor` and `/ccx:loop` session on the host, and retained in memory across supervisor runs. A loose match would pick up stale entries that have nothing to do with this worker's actual exit. The three filters below are independent and all must apply:

   1. **`cwd == meta.worktree_path`** — the broker is host-global, so two checkouts of different repos (or the same repo under two checkout paths) can each launch a worker whose branch is `ccx/T-1`. Without this filter, a stuck exit in repo A could misclassify a worker in repo B. `meta.worktree_path` was captured at dispatch time (Step A step 7) as the absolute path `<REPO_ROOT>-<task_id>`, which is also exactly the `cwd` that `/ccx:loop --worktree` passes to `chat_register`. Exact-equality on cwd scopes the match to this supervisor's repo unambiguously.

   2. **`branch == "ccx/<task_id>"`** — obvious task-level scoping.

   3. **`at >= meta.started_at`** — closures survive broker restarts within the in-memory ring (they do not survive a broker process restart, but they survive across `/ccx:supervisor` invocations as long as the broker stays alive). A rerun of the same task id after a prior run could otherwise hit an old `stuck` closure from the prior run if the current worker exits `no-commit` without ever calling `chat_close` (broker unreachable, worker crash-before-close, etc.) — the ring buffer would still hold the prior run's `stuck` entry and the classifier would pipe the current fresh `no-commit` into §P2.5 even though THIS attempt never reported stuck. `meta.started_at` was captured at dispatch time (initial: Step A step 6; re-dispatch: §P2.5 step 9's in-place update) and is guaranteed to be later than every closure from a prior attempt or prior run on the same branch. `at` and `started_at` are both UTC ISO 8601 strings — lexicographic comparison is safe because UTC ISO 8601 is monotonic.

   **Latest-match rule (on the scoped set).** After all three filters, the lookup MUST pick the most recent remaining closure and then check `status == "stuck"` on THAT single record — NOT scan for any stuck entry in the scoped set. After a stuck-triggered re-dispatch (§P2.5 step 8) the worker keeps the same branch name `ccx/<task_id>`, so a subsequent non-stuck exit (e.g. the second attempt exits with `cap-hit` or `filtered-clean`) appends a fresh closure record alongside the earlier stuck record and both entries pass the cwd/branch/started_at filter. A loose "find any stuck in the scoped set" match would re-route that second exit into §P2.5 even though the live exit was not stuck, and §P2.5 step 1's `attempts >= STUCK_REDISPATCH_CAP` gate would then block the task as `stuck-exhausted` — a misclassification that hides the real exit reason from the human and from P3 reporting. Sorting the scoped set by `at` ascending and taking the tail entry is the contract; equivalently, `max(scopedClosures, key = at)`. The broker preserves insertion order when pushing, so for buffers under the cap this is already `scopedClosures[scopedClosures.length - 1]`; sort explicitly anyway to make the contract robust against future buffer reordering (e.g. if the buffer is ever extended to evict oldest-by-timestamp instead of oldest-by-insertion).

   Rationale for the fallthrough on query failure: stuck recovery is best-effort. If the broker is in Discord-only mode, the `chat_supervisor_recent_closures` tool is unavailable and M5 silently degrades to the M4 behavior (mark blocked, human handles manually). If the tool is available but errors transiently, the task is still correctly classified as `no-commit` — the human loses the auto-revise convenience for this run but no data is lost.

   **Tool-availability gate.** Before the first query, verify `mcp__ccx-chat__chat_supervisor_recent_closures` is in the session's available tool surface (same check Step B2 performs for `chat_supervisor_poll`). If absent, set a run-level flag `M5_DISABLED = true`, log once `M5 stuck recovery disabled: chat_supervisor_recent_closures tool unavailable`, and skip every subsequent per-task stuck query for the remainder of the run. This mirrors Step B2's `SKIP_B2` pattern — avoid hammering an MCP surface that is definitively missing.

   **Stale-broker degradation (call-time safety net).** Even when the tool IS advertised, a stale detached broker from an older install may be holding the socket — the MCP server can only filter its advertised tool list if the broker's capability probe completed before `listTools` ran. When the supervisor's query errors with a message matching `requires a newer ccx-chat broker` or `unknown op: supervisorRecentClosures` (substring, case-insensitive), treat that as equivalent to the tool being unavailable: set `M5_DISABLED = true`, log once `M5 stuck recovery disabled: ccx-chat broker is out of date — restart it with 'pkill -f ccx-chat/broker.mjs' and re-run the supervisor`, and fall through to the generic no-commit handling for this task (and every subsequent no-commit task this run). Without this recognition, every stuck worker after an upgrade-server-but-not-restart-broker event would repeatedly re-encounter the same error and mis-classify as generic no-commit with a confusing stderr trail; treating it as M5_DISABLED surfaces one clear restart instruction and degrades cleanly. Any OTHER error (timeout, transient IPC drop) remains a per-task fallthrough to no-commit per the existing "Rationale for the fallthrough on query failure" clause — only the stale-broker signatures are sticky.

   **Generic no-commit handling** (reached when the stuck sub-classifier does not trigger): append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "no-commit"`, `notes: "see .ccx/workers/<task_id>.log"`. (`PENDING_POOL` already has this task removed from Step A step 7; the pool-removal rule requires nothing further here.)

   **For error:** append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "error"`, `notes: "see .ccx/workers/<task_id>.log"`. The M5 stuck sub-classifier is NOT consulted for `error` outcomes — a non-zero shell exit means the worker crashed before it could call `chat_close`, so the closure ring buffer has no entry to examine and re-dispatch would almost certainly hit the same crash again.

5. Remove `task_id` from `RUNNING`.
6. Print a one-line completion notice summarizing outcome + duration + log path.

### Step B2 — Answer supervisor asks

Before the first iteration of the scheduling loop runs Step B2, initialize two in-run flags — `SKIP_B2 = false` and `B2_TRANSIENT_STREAK = 0` — and load `AUTO_ESCALATE_AFTER_SEC` from `config.json` (see "Pre-loop initialization" below). Once `SKIP_B2` is set to `true` (either definitively via a "not in supervisor mode" response, or after sustained transient failures — see step 1), every subsequent iteration's Step B2 is a no-op until the run ends.

**Pre-loop initialization (done once per supervisor run, before the scheduling loop starts):**

- Resolve the broker home the same way the broker does: `CCX_CHAT_HOME` env var if set, else `~/.claude/ccx-chat` (see `plugins/ccx/mcp/ccx-chat/paths.mjs`). Shell: `CCX_CHAT_HOME="${CCX_CHAT_HOME:-$HOME/.claude/ccx-chat}"`.
- Read `"$CCX_CHAT_HOME/config.json"` if present and set `AUTO_ESCALATE_AFTER_SEC = config.supervisor.autoEscalateAfterSec`; fall back to `60` when the field or file is absent (matches `DEFAULT_AUTO_ESCALATE_SEC` in `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`). The broker's own startup validation clamps to `[5, 3600]`, so M3 does not re-clamp.
- **Drift warning.** The broker reads `config.json` only at startup. `config.json` is therefore an operator-facing hint, not a safety invariant. §P2.3's race cutoff leaves a 3-second buffer and the broker's own auto-escalate timer is the ultimate backstop. Instruct operators to restart the broker after editing `autoEscalateAfterSec` so the two stay in sync — M3 does NOT reload config mid-scheduling-loop, matching the broker's own single-read semantics.

**Per-iteration Step B2:**

1. If `SKIP_B2 == true`, skip Step B2 entirely and go to Step C. Otherwise, first verify that the `mcp__ccx-chat__chat_supervisor_poll` tool is available in this session's tool surface (check the available-tools list — if `/ccx:chat-setup` has not registered the `ccx-chat` MCP server, the supervisor tools are absent entirely). If the tool is NOT available, log once to stderr `M3 Step B2 disabled: ccx-chat MCP not registered (run /ccx:chat-setup). Worker asks will reach humans via the broker's auto-escalate path, if any.`, set `SKIP_B2 = true`, and skip to Step C. Matches the tool-availability check `/ccx:loop` Phase 0.7 performs for its own chat bridge.

2. Call `mcp__ccx-chat__chat_supervisor_poll` with `{}`. This ONE poll call serves two purposes: it probes whether the broker is in supervisor mode, and it returns the list of queued asks. Do NOT read `config.json` to gate this — the running broker's state, not the file, is the source of truth.
   - **Success** (a result object, possibly with empty `asks`) → the broker is in supervisor mode. Reset `B2_TRANSIENT_STREAK = 0` (see below). Continue to step 3 with `asks`.
   - **Error message contains `not in supervisor mode`** → the broker is definitively Discord-only (this is not a transient condition — the broker decides its backend at startup and never flips). Set `SKIP_B2 = true`, log once to stderr, and skip to Step C. Worker `chat_ask` calls continue reaching humans via the broker's Discord path.
   - **Any other error** (IPC down, transient reconnect, broker restart window) → treat as transient by default, NOT terminal. Increment a per-run counter `B2_TRANSIENT_STREAK` (starts at 0; resets on any successful poll). Log the error with `B2_TRANSIENT_STREAK` to stderr, then skip to Step C this iteration — the next iteration probes again so a brief broker restart or MCP reconnect does not disable M3 for the whole run. If `B2_TRANSIENT_STREAK >= 20` (about 60s of consecutive failures at the 3s Step C cadence), the broker is likely wedged rather than restarting — set `SKIP_B2 = true`, log the terminal transition once, and stop probing. The broker's own auto-escalate-after-`AUTO_ESCALATE_AFTER_SEC`-seconds timer remains the safety net during the transient window.

3. If `asks` is empty, skip to Step C.

4. **Filter to this supervisor's asks.** Since `chat_supervisor_poll` returns asks for the whole broker queue (every concurrent ccx session on this host, not just this supervisor's workers), this run MUST only act on asks it owns. Ownership is keyed off the **`DISPATCHED` set** — every `<TASK_ID>` this supervisor has ever launched in this run, never removed even after the worker exits or the task gets `merged` / `blocked`. Maintain `DISPATCHED` by adding `<TASK_ID>` in Step A at step 7 (right where `RUNNING[<TASK_ID>]` is populated) and NEVER deleting from it. Reason: a worker can emit `chat_ask` and exit before the next Step B2 poll; its entry will already be out of `RUNNING` by the time we filter, but it is still legitimately our ask to answer. For each returned ask:
   - Read `"$CCX_CHAT_HOME/sessions.json"` (the broker persists its registry there — see `plugins/ccx/mcp/ccx-chat/paths.mjs`; the file has shape `{ sessions: [{ id, label, cwd, branch, ... }], ... }`). Find the entry whose `id == sessionId`.
   - If the entry exists AND its `branch` is `"ccx/<TASK_ID>"` for some `<TASK_ID>` in `DISPATCHED`, tag the ask as owned and attribute it to `<TASK_ID>`.
   - Otherwise, the ask is either (a) foreign — owned by a concurrent `/ccx:supervisor` run — or (b) not yet attributable (sessions.json stale or missing, worker just registered and hasn't persisted). **Leave it pending**: do NOT call `chat_supervisor_reply`, do NOT call `chat_supervisor_escalate`, and do NOT write an audit entry for it. The owning supervisor (if any) will handle it on its own poll; if nothing handles it, the broker's auto-escalate-after-`AUTO_ESCALATE_AFTER_SEC`-seconds timer pushes it to Discord. Stealing the ask with our own escalate call would force the foreign supervisor's question to Discord before its real owner could answer it deterministically — silent interference between supervisors. Maintain an in-memory count `foreignAsksSkipped` per run for P3 reporting; do not log per-occurrence to avoid flooding stderr when both supervisors poll on a 3s cadence.

5. If no asks remain after filtering in step 4, skip to Step C.

6. **Do not spend the entire iteration on one ask.** Sort the owned asks by `ageSec` descending (oldest first) and handle at most `len(RUNNING) + 1` per Step B2 pass — the remainder wait one Step C cycle (3s) before the next poll. Rationale: a single slow autonomous-answer decision must not starve completion draining or newly-freed slot-filling for the rest of the run.

7. For each owned ask selected above (the `<TASK_ID>` was attributed in step 4):

   a. **Consult three sources, in order.** Stop at the first source that meets §P2.3's confidence rubric.

      1. **Brief `## Decisions` table** — `Read` `REPO_ROOT/.ccx/tasks/<TASK_ID>.md` (the committed supervisor-owned copy at `REPO_ROOT`, NOT the worktree copy — the worktree copy could have been edited by the worker even though the dispatch prompt forbids it; reading the integration-branch copy keeps supervisor decisions traceable to dispatch-time content). Parse the `## Decisions` section as a YAML-ish list of `- q: "…"` / `  a: "…"` pairs. Match the ask's `prompt` against each `q` semantically — paraphrase is fine, topic drift is not.
      2. **BOARD `## Direction`** — `DIRECTION_TEXT` captured in P1. Match for project-wide policy statements that directly answer the ask (e.g. "prefer stdlib over third-party deps" answers "can I add lodash?").
      3. **Integration-branch worker-commit history** — `git log "<INTEGRATION>" -n 40 --no-merges --format='%H%x09%s%x09%b'`. Scan each commit's subject + body for lexical hits on the ask's prompt. `--no-merges` is important: Step B creates merge commits with `git merge --no-ff --no-edit`, which produces a `Merge branch 'ccx/T-<id>'` subject and an **empty body**, so the worker rationale we want lives on the worker's own commits (still reachable from the integration branch after `--no-ff`). Worker commit subjects typically describe the change and — via `/ccx:loop`'s Phase 4 — often carry a rationale paragraph. Include the worker commit SHA (first 8 chars) in the reply citation, not the merge SHA.

   b. **Decide.**
      - **Confident match** (see §P2.3) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply}`. The reply MUST begin with a one-line source citation — `"From brief Decisions: "`, `"From BOARD direction: "`, or `"From worker-commit <first 8 chars of SHA>: "` — so the worker can push back if the match was wrong.
      - **No confident match** → call `mcp__ccx-chat__chat_supervisor_escalate` with `{askId}`. A human answers on Discord; the reply flows back through the broker automatically.
      - **Explicit refusal** (the ask describes something the brief explicitly forbids, e.g. editing a path outside `scope.include`) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply: "Refused: <one-sentence reason citing the brief>. Do not proceed — abort via chat_close({status: \"aborted\"}) and surface the blocker in the worker log."}`. Do NOT use `chat_supervisor_close`: that returns `source: "closed"` to the worker, which `/ccx:loop`'s `chat_ask` failure path handles by calling `AskUserQuestion`. Workers dispatched by the supervisor run under `claude -p` where `AskUserQuestion` cannot resolve, so a closed reply would hang the worker or derail it into an aborted cycle. A deterministic refusal reply gives the worker a usable answer it can cite in its own cycle summary.

   c. **Audit.** After the broker tool returns, append ONE JSONL line to `REPO_ROOT/.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`. Field schema (all string fields MUST be valid JSON — pass them through a JSON-string encoder before interpolation so embedded quotes, backslashes, and newlines are escaped; raw heredoc interpolation is FORBIDDEN because worker prompts and supervisor replies routinely contain `"` / `\` / newlines):

      ```json
      {"ts":"<UTC ISO 8601>","askId":"<askId>","taskId":"T-<id>","sessionId":"<sessionId>","ageSec":<ageSec at poll>,"prompt":<JSON.stringify(first 200 chars of prompt)>,"decision":"reply|escalate","source":"brief|direction|worker-history|none","citation":<JSON.stringify(source span / commit SHA / q-text) or null>,"reply":<JSON.stringify(first 200 chars of reply) or null>,"brokerOk":<true|false>}
      ```

      Concrete implementation sketch: build the line with `node -e 'process.stdout.write(JSON.stringify({ts:…, prompt:…, …})+"\n")' >> .ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` or write a small inline `jq -n` expression — either produces valid JSON regardless of input. If the broker call returned `{ok: false}` (ask already resolved by auto-escalate timer or session cancel), still write the audit line with `brokerOk: false` so the trail is complete. Create the log file the first time it is needed; the `.ccx/` directory was created in P0. Never truncate the file; never use `echo "…"` heredoc interpolation for JSON payloads — it cannot safely encode untrusted strings.

### Step C — Sleep and repeat

Sleep 3 seconds (`sleep 3`). Go back to the top of the iteration — **re-evaluate all three exit conditions first** (after A1 recomputes `READY`), then run Steps A → B → B2 in order if none of the three conditions fires. A1 is where newly-unblocked dependents get picked up by a fresh merge; B2 is where supervisor-mode runs drain worker `chat_ask` queues (Discord-only runs skip B2). This iteration shape guarantees the loop cannot spin in any of the documented failure modes:
- (a) all remaining pending tasks depend on `blocked` predecessors → condition 1 fires once `RUNNING` drains.
- (b) `--max-tasks` has been reached with tasks still pending → condition 2 fires once `RUNNING` drains.
- (c) `STOP_DISPATCHING` was set by Step B's merge-commit-failed branch (M4) and `PENDING_POOL` still holds untouched tasks → condition 3 fires once `RUNNING` drains. Without checking condition 3 here, A1 keeps `READY` populated from `PENDING_POOL` and the loop would spin forever in this exact failure mode the M4 path is meant to handle.

### Step D — Batch BOARD.md commit

After the loop exits, apply all stashed BOARD-row updates to `BOARD.md` in one edit pass, then stage the supervisor-owned files that changed this run:

```bash
git add -- BOARD.md
# Stage the audit log only if it was written (M3 supervisor-mode runs).
# Discord-only runs never create this file, and the `test -f` guard keeps them
# from failing. `.jsonl` is deliberately chosen (not `.log`) so this file is
# not matched by the repo's `*.log` ignore rule.
test -f .ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl && git add -- .ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl
git commit -m "supervisor: update board — merged <MERGED_IDS>, blocked <BLOCKED_IDS>"
```

Commit rules:

- If `MERGED_IDS` and `BLOCKED_IDS` are both empty AND the audit log was not written this run, skip the commit silently (no-op run).
- If the only change is the audit log (no merges, no blocks), still commit — the JSONL trail is valuable audit evidence even for a quiet run. Adjust the subject to `supervisor: audit-only run — <N> supervisor decisions`.
- Never use `git add -A` or `git add .` — explicit paths only. The audit log and `BOARD.md` are the only files the supervisor owns on the integration branch mid-run.

**Commit-failure recovery.** If `git commit` fails (pre-commit hook, signing, branch protection), the in-memory BOARD updates and the audit log are at risk of being lost from the integration history — but `BOARD.md` is already modified on disk by this point and the audit JSONL is already written. To prevent stranded `assigned` rows and orphaned audit lines:

1. Do NOT retry the commit, do NOT skip hooks (`--no-verify` would mask the underlying problem and leave the user with an unsigned/un-hooked commit they did not opt into), do NOT `git reset` the staged paths.
2. Write/append a recovery sidecar at `REPO_ROOT/.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` listing every `MERGED_IDS` / `BLOCKED_IDS` row, the audit JSONL path, and the verbatim `git commit` stderr. If the merge-commit-failed branch in Step B already wrote this sidecar, **append** to it (do not overwrite — both records are needed).
3. Leave `BOARD.md` modified on disk and the audit JSONL on disk so the human can stage and commit them manually after fixing the hook/signing condition. Print the recovery sidecar path and the verbatim instructions to STOP-with-error in the P3 report.
4. STOP the supervisor run with non-zero exit semantics. The next supervisor run will hit P0 step 3's "clean working tree" check and refuse to start until the human commits or stashes the recovery edits, which is exactly the right gate — there is no safe way to continue dispatching while the integration branch's commit pipeline is broken.

This single batch commit replaces per-task BOARD updates to keep the integration history clean (see §10 of the design doc).

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

<!-- No seeded decisions. Supervisor's M3 autonomous-answer loop (§P2.3) treats
this section as the highest-confidence source and parses it for `- q:` / `  a:`
YAML-ish pairs; leaving it empty (no such pairs) means unknown questions
escalate to Discord as before. HTML comments are invisible to the Tier-1
parser, so this default yields an empty decision list. To seed deterministic
answers, replace this comment block with real `- q:` / `  a:` entries. -->
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
of the brief, call chat_ask with the specific question. The
supervisor's broker adapter (M2) queues the ask; the supervisor
session (M3) may reply autonomously from the brief Decisions /
BOARD direction / merge history, otherwise it escalates to a human
on Discord. Either way, your chat_ask returns the reply verbatim.
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

### P2.3 — Match-confidence rubric

A "confident match" is one where the supervisor is willing to answer a worker's `chat_ask` WITHOUT human review. The rubric is conservative — when in doubt, ESCALATE. A wrong autonomous answer costs more than a late one because it propagates into the worker's Phase 1 implementation and gets baked into a commit before Codex review can catch it.

- **Tier 1 — Brief `## Decisions` entry (CONFIDENT).** Reply if the ask asks substantively the same question as a `- q:` entry in the brief's Decisions section. Paraphrase is fine ("which of X vs Y?" matches `q: "X vs Y?"`). Do NOT stretch across topics: an ask about library X does not match a decision about library Z just because both are "library choice" questions.
- **Tier 2 — BOARD `## Direction` direct policy hit (CONFIDENT).** Reply if `DIRECTION_TEXT` contains a policy statement that concretely answers the ask. "Prefer stdlib over third-party deps" answers "can I add `lodash`?" with "no, use stdlib". Do NOT fabricate policy from vague direction — "focus on reliability" is not a concrete answer.
- **Tier 3 — Prior worker commits on the integration branch (LESS CONFIDENT).** Reply only if a recent worker commit's subject + body (via `git log --no-merges`, so merge commits are excluded since `--no-ff --no-edit` leaves them empty-bodied) contains a decision that clearly governs the ask. Include the worker commit SHA (first 8 chars) in the reply. SKIP this tier when the ask is safety-sensitive (touching auth, data migrations, destructive operations, secret handling, network/filesystem permissions) — those always escalate.
- **Everything else → ESCALATE.** Ambiguous match, multiple conflicting sources, safety-sensitive, no source hit at all. Escalation is the default; autonomous answering is an optimization over always-escalating, not a replacement for human judgement.

**Auto-escalate race.** The broker's auto-escalate timer is the hard deadline, but the broker applies a **per-ask clamp**: `SupervisorAdapter.enqueue()` in `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs` sets the real delay to `min(AUTO_ESCALATE_AFTER_SEC, max(1, floor(timeoutSec) - 2))` when the worker supplied a finite positive `timeoutSec`, and `AUTO_ESCALATE_AFTER_SEC` otherwise. For each polled ask, compute the per-ask deadline the same way using the `timeoutSec` field returned by `chat_supervisor_poll`:

```
perAskDeadlineSec =
  (timeoutSec is a finite positive number)
    ? min(AUTO_ESCALATE_AFTER_SEC, max(1, floor(timeoutSec) - 2))
    : AUTO_ESCALATE_AFTER_SEC
```

If `ageSec >= perAskDeadlineSec - 3`, skip the decision work and call `chat_supervisor_escalate` immediately — the broker's timer is about to fire (or has already fired). Using the global value alone would miss short-timeout asks: a worker calling `chat_ask({timeoutSec: 30})` with `AUTO_ESCALATE_AFTER_SEC = 60` has a real deadline of 28s, not 57s; treating 40s as "still safe" races an ask the broker already escalated. The cutoff MUST derive from the per-ask deadline, not the raw config value.

Explicit escalation (via `chat_supervisor_escalate`) rather than lost `chat_supervisor_reply` calls keeps the audit log clean: a racing reply would land as `brokerOk: false` (the adapter already resolved the ask), which clutters the JSONL trail without changing the outcome.

### P2.4 — Scope-overlap detection

Step A's overlap gate (A2 step 1a) decides whether `TASK.scope.include` overlaps with any `RUNNING_TASK.scope_include`. Two tasks "overlap" when there is at least one tracked file that both task scopes would include — at that point a parallel dispatch risks producing two worktrees that edit the same file and a merge conflict downstream. The algorithm below errs on the side of serializing: a false-positive overlap defers a task by one Step C cycle (3s); a false-negative lets two workers race the same file.

**Algorithm** — applied to every `RUNNING_TASK` for the popped `TASK`. Stops at the first overlap detected (one match is enough to defer).

1. **Build the candidate file set per task.** For each glob list, invoke `git ls-files` via **direct exec with each glob as its own argv element** — never via a shell-snippet that joins globs into a single string. The shell would expand `*`/`?`/`[…]` against the supervisor's `cwd` (with semantics that differ from Git's: `nullglob` drops unmatched literals, default bash keeps them as literal strings, `failglob` errors out — none of those is what the supervisor wants), so passing glob strings through a shell would silently corrupt overlap detection for any task whose `scope.include` uses real wildcards. Direct exec sidesteps the shell entirely and lets Git perform pathspec resolution itself, against the integration tree, with its own `**` / `*` / class-bracket semantics. This also makes the BOARD glob-string contract narrower: only NUL and newline are forbidden (§P1 step 2), which lines up with the legal Git path character set.

   Build the argv array programmatically (each glob becomes one element); never join globs into a single space-separated string, and never route this call through `sh -c`:

   ```
   argv = ["git", "-C", REPO_ROOT, "ls-files", "-z", "--"]
   for glob in TASK.scope.include:
       argv.append(glob)            # one argv element per glob, NEVER passed through a shell
   spawn(argv)                      # exec(argv), not exec("sh", "-c", joined_string)
   ```

   This contract holds regardless of how the tool runtime spells the call — `Bash` tool calls that need overlap detection must build a single-string command that the shell will not re-glob (use a `bash -c` wrapper that quotes via `printf %q` per element if absolutely necessary, but prefer a Node/Python helper that calls `child_process.spawn` / `subprocess.run` with the argv array directly). Documentation snippets that show a copy-pasted `git -C "$REPO_ROOT" ls-files -z -- ...` form are NOT part of the contract and MUST NOT be used at runtime — they exist only to make the intent legible to a human reading the prompt.

   `-z` is required — file paths can contain spaces, tabs, or shell-special characters; newlines must not be relied on as a separator. Parse the NUL-separated output into a set of repo-relative paths. Use `git ls-files` (not `find` or `git ls-tree`) so untracked-but-tracked-after-add files behave consistently with the rest of the supervisor's path logic, and so the `.gitignore` semantics match the integration branch's view.
   - Run from `REPO_ROOT` via `-C`, not from the worker worktrees — `RUNNING_TASK.scope_include` was captured at dispatch time on the integration branch and reflects the integration tree's contents. Worktree contents have diverged.
   - Cache per-task results within a single Step A pass (the gate may compare the same `RUNNING_TASK` against several popped candidates). Do NOT cache across passes — the integration tree mutates as merges land in Step B.

2. **Intersect.** If `set(TASK_FILES) ∩ set(RUNNING_TASK_FILES)` is non-empty, the two tasks overlap. Record up to 3 sample paths from the intersection for the deferral notice (sorted ascending so the diagnostic is stable across runs).

3. **Empty-match fallback (two tiers).** Globs may match zero current files (e.g. a brand-new directory the task will create). `git ls-files` returns the empty set for those globs, so the intersection from step 2 is trivially empty and would silently say "no overlap" even when two tasks plan to write into the same future directory. The fallback runs in two tiers; either tier triggering an overlap is sufficient.

   **Normalization (applies to both tiers).** Collapse repeated `/` runs (`a//b` → `a/b`). Do NOT trim leading or trailing whitespace — P1 step 2 explicitly permits whitespace in glob strings (Git allows spaces in committed paths, e.g. `"assets/logo .svg"`), and trimming would silently change which file path the glob refers to and let the gate compare a different path than the BOARD declared. Do NOT case-fold; on case-insensitive filesystems two literally-different globs may still collide, but that is a filesystem-policy edge case the supervisor does not try to resolve.

   **Tier 3a — literal-string equality.** If any normalized glob string from `TASK.scope.include` matches any normalized glob string from `RUNNING_TASK.scope_include` byte-for-byte, the two tasks overlap on that glob string. Record the matching glob string (not a file path) for the deferral notice.

   **Tier 3b — glob-prefix coverage.** Pure literal-string equality misses the common case of broad-vs-narrow patterns over a directory that does not exist yet — `src/**/*.ts` vs `src/foo/*.ts` would both be byte-different and both produce empty `git ls-files` output, yet they obviously overlap once `src/foo/` is created by either worker. To catch this:

   - Compute each normalized glob's **literal prefix**: the longest leading substring containing no Git pathspec metacharacter (`*`, `?`, `[`, `]`). Curly braces (`{`, `}`) are NOT Git pathspec metacharacters — Git pathspecs do not implement brace expansion (that is a shell feature). A BOARD glob like `src/{a,b}/*.ts` matches a file literally named `{a,b}` under `src/`, not files under `src/a/` or `src/b/`. The supervisor does NOT special-case braces and treats them as literal characters; if an operator wrote a brace pattern intending shell-style alternation, that is a BOARD authoring bug they will see at dispatch time when `git ls-files` returns an unexpected (likely empty) set. Examples: `src/**/*.ts` → `src/`; `src/foo/*.ts` → `src/foo/`; `src/foo.ts` → `src/foo.ts` (no metacharacter, the whole string is its prefix); `**/foo.ts` → `` (empty prefix); `[abc]/lib.ts` → `` (leading metacharacter); `src/{a,b}/*.ts` → `src/{a,b}/` (braces are literal — only the trailing `*` is a metacharacter).
   - Two normalized globs are flagged as overlapping under Tier 3b when ALL of the following hold:
     1. Glob A and glob B are NOT byte-identical (Tier 3a already covers that case).
     2. Either glob A or glob B contains a glob metacharacter (two purely-literal paths can only overlap by being identical, which Tier 3a handled — and `git ls-files` would have caught any extant file).
     3. **At least one of the two prefixes is non-empty.** When both prefixes are empty (both globs lead with `**` or a character class), the prefix algorithm has no usable signal — `**/foo.ts` and `**/*.md` are unrelated future-file patterns, but a naive empty-prefix-equals-empty-prefix match would over-defer them and turn the gate into a near-global mutex for any repo that uses leading-`**` patterns. The principled handling is to skip Tier 3b in that case and let the "still undecidable cases" note (below) cover them; tasks whose scopes both lead with `**` should declare `depends_on` explicitly when they actually conflict.
     4. One of the prefixes is a path-prefix of the other (treat the prefixes as `/`-separated path segments, so `src/foo/` is a prefix of `src/foo/bar/` but `src/foo` — without trailing slash — is NOT a prefix of `src/foobar/`; normalize each prefix to end with `/` unless it is empty for this comparison). With clause 3 enforcing that at least one prefix is non-empty, this comparison is well-defined.
     5. The "wider" glob (the one whose prefix is shorter, or the one with metacharacters when the prefixes are equal) actually has a chance of matching paths under the narrower's prefix — proxy: the wider glob contains `**`, OR the segment immediately following the shared prefix in the wider glob is a single `*`, OR the wider glob's prefix equals the narrower's prefix exactly (in which case both globs match files in the same directory).
   - Record the deferral notice as `glob-prefix overlap: <wider> covers <narrower>` so the human sees which two patterns the gate considered conflicting.

   **Conservative bias.** Both tiers err toward false positives (defer when in doubt) over false negatives (let two workers race the same file). A false positive costs one Step C cycle (3s) of waiting for the running task to drain; a false negative costs a merge-conflict and a `blocked` task. When the prefixes are entirely disjoint (`src/lib/` vs `tests/api/`), no tier fires and the tasks run in parallel as intended. The empty-prefix carve-out in clause 3 above is a deliberate exception to the conservative bias: defer-on-any-leading-`**` would punish broad-pattern repos for no real benefit, so we accept the rare false negative there in exchange for retaining parallelism in the common case.

   **Still undecidable cases.** Pure character-class overlap (`src/[ab]*` vs `src/[bc]*`) is not detected — class-vs-class coverage analysis is undecidable in general. Two-leading-`**` pattern pairs (per clause 3 above) are also not detected by Tier 3b. Tasks that intend to overlap on these patterns should declare `depends_on` explicitly. Document this as a known M4 gap; M5 may revisit if the case turns up in practice. Brace alternation patterns (`src/{a,b}/*.ts`) are not in this list because Git pathspecs do not interpret braces — those globs match literal `{a,b}` paths and so are not a coverage-analysis problem at all (they will simply match the wrong files at dispatch time, which is a BOARD authoring mistake the operator should see and fix).

4. **`scope.exclude` is ignored by the overlap gate.** A file matched by an `include` glob and also by an `exclude` glob is per-task out-of-scope, but the gate's job is parallelism safety — encoding exclude rules into overlap detection would let two tasks claim the same `include` set with mutually exclusive `exclude` filters, then race when one of them edits a file the other thought was off-limits. The conservative policy is: `scope.include` is the contract for which files a task **may** touch; that's what overlap is computed against. If two tasks need disjoint slices of the same directory, model it via separate `include` globs, not via overlapping include + differing exclude.

5. **Failure modes.** `git ls-files` should never fail on a clean integration branch — P1 step 2's pathspec sanity probe has already validated every task's `scope.include` and `scope.exclude` against this exact tree, so any runtime failure here is **not** a pathspec issue. The remaining causes are repo-level: a locked or corrupt `.git/index`, a missing or unreadable object, a filesystem permission revocation between startup and now, or another process holding a write lock. None of these are wait-and-retry transient — they all require human intervention to clear, and silently deferring would either spin forever (because A1 clears `DEFERRED_THIS_PASS` every pass and `READY` keeps re-including the task once `RUNNING` drains, so no exit condition fires) or, worse, produce a false-negative overlap result if the supervisor decided to skip the gate after some retry count.

   The correct response is to **STOP the whole supervisor run immediately** on the first runtime `git ls-files` failure inside the overlap gate, but the STOP MUST be accompanied by a **comprehensive recovery sidecar** so already-`assigned` workers do not get orphaned. P1 step 3 excludes `assigned` rows from `PENDING_POOL` on every future run, and the in-memory `status: "assigned"` BOARD update committed in Step A step 6 is already on the integration branch — without explicit recovery instructions, every in-flight worker becomes invisible to future supervisor runs even after the human resolves the repo issue.

   Concrete sequence on first runtime `ls-files` failure in the gate:

   1. Capture the verbatim stderr from the failed call (`LS_FILES_STDERR`).
   2. Do **not** attempt Step D. The integration index may be locked or corrupt, so any `git add` / `git commit` would either fail or produce a damaged commit; defer all BOARD/audit persistence to human triage.
   3. Do **not** attempt to kill the in-flight `claude -p` workers. They are running in their own worktrees on their own branches; the integration-side repo issue does not affect their progress, and killing them would lose their work. Let them continue; the human will classify their final state manually after the repo is fixed.
   4. Write `REPO_ROOT/.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` (append if the merge-commit-failed branch already wrote one — both records are needed) with these sections, in this order:
      - **Cause**: `git ls-files refused inside the M4 overlap gate at <UTC ISO 8601>`. Include `LS_FILES_STDERR` verbatim.
      - **Already-merged tasks** (`MERGED_IDS`): the integration branch already holds these merges; the BOARD-row updates were stashed in memory but not yet persisted by Step D. List each as `T-<id> — needs BOARD row update to status=merged, exit_status=approved`.
      - **Already-blocked tasks** (`BLOCKED_IDS` + their stashed BOARD-row updates): same situation; list each with the verbatim `exit_status` and `notes` text the supervisor would have written via Step D.
      - **In-flight workers** (`RUNNING`): list each as `T-<id> — branch ccx/<id> — worktree <REPO_ROOT>-<id> — log <log_path> — shell <shell_id>`. Tell the operator: "These workers are still alive at STOP time. After fixing the repo issue, inspect each log to determine its final outcome and either run `/ccx:supervisor` again (which will detect the worktree+branch and surface the resulting commit on the next dispatch — assuming the BOARD row is back to `pending`) or manually merge `ccx/<id>` and update the BOARD row from `assigned` → `merged`/`blocked`."
      - **Untouched pending tasks** (`PENDING_POOL` minus the IDs already in MERGED/BLOCKED/RUNNING): list each as `T-<id> — pending, untouched by this run`. These need no manual action; a future supervisor run will pick them up automatically once the repo is healthy.
      - **Manual remediation steps**: a numbered checklist starting with "Resolve the underlying repo issue (locked index, permissions, corruption — see stderr above)", then "Manually apply the BOARD-row updates from the merged/blocked sections above", then "For each in-flight worker, decide based on its log".
   5. Print the absolute sidecar path, the verbatim `LS_FILES_STDERR`, and a one-line summary `M4 overlap gate aborted: <count> merged, <count> blocked, <count> in-flight workers; see <sidecar path>` to the user. STOP with a non-zero exit.

The gate intentionally does NOT enumerate the cross product of every `READY` task pair — only the popped candidate against currently `RUNNING` tasks. Two `READY` tasks that overlap with each other but neither with `RUNNING` will both be popped sequentially: the first one transitions into `RUNNING`, then the second is checked against it on the inner-loop's next iteration. This is correct because dispatch is sequential within one Step A pass — there is no point at which two `READY` tasks become `RUNNING` simultaneously.

### P2.5 — M5 stuck-exit recovery

Step B step 4's stuck sub-classifier routes here when the broker's recent-closures buffer reports `status == "stuck"` for the worker's branch. `/ccx:loop` Phase 2 Step B stuck-finding detection fires when the same finding `(file, title, body)` key recurs across three consecutive Codex review cycles — the worker has tried twice to satisfy Codex and failed, so continuing to spin is unlikely to help. The supervisor's job here is to capture one chance at human-provided guidance, fold it into the brief's `## Decisions` section, and re-dispatch exactly once. A second stuck exit on the same task is terminal: `stuck-exhausted`, no human prompt, move on.

Every step below runs synchronously inside Step B's per-task drain loop — the scheduling loop blocks on the `AskUserQuestion` call in step 2, which is acceptable because (a) the M5 path is rare compared to the happy path, (b) other `RUNNING` workers keep executing as subprocesses while the supervisor is waiting for a human reply, and (c) the broker's own auto-escalate timer (60s default) is the safety net for any peer worker that emits a `chat_ask` during the wait.

**Algorithm:**

1. **Attempt-cap check.** If `meta.attempts >= STUCK_REDISPATCH_CAP` (default 2), the task has already consumed its one re-dispatch:
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-exhausted"`, `notes: "stuck after <meta.attempts> attempts — inspect .ccx/workers/<task_id>.log and revise brief Decisions manually, then re-run supervisor"`.
   - Write an audit entry with `decision: "stuck-exhausted"`, `source: "attempt-cap"`, `citation: null`, `reply: null`, `brokerOk: null` (the stuck-* audit records reuse the Step B2 JSONL schema; see "Audit entries" below).
   - Remove `<task_id>` from `RUNNING`. Continue the outer Step B drain loop — other tasks still need classification.

2. **Tail the worker log for stuck-finding details** (best-effort input to the human prompt). Read the last ~200 lines of `.ccx/workers/<task_id>.log`. Extract any lines whose content references "stuck" (case-insensitive) or the finding tuple — `/ccx:loop`'s stuck report is freeform Claude-generated prose, so the supervisor does NOT attempt structured parsing. The tailed excerpt is plumbed verbatim into the AskUserQuestion prompt so the human sees what Codex kept flagging. If the log is unreadable (rare — it was being written to by the worker moments ago), substitute the literal string `(log unavailable — inspect .ccx/workers/<task_id>.log manually)` and proceed; the human can still decide without machine-extracted context.

3. **Also read the brief's current `## Decisions` section** from `REPO_ROOT/.ccx/tasks/<task_id>.md`. Include the section body (max first 1500 chars) in the prompt so the human sees what was already seeded before adding another entry.

4. **Ask the human** via a single `AskUserQuestion`. `AskUserQuestion` always exposes an "Other" free-text response alongside the labeled options, so the supervisor encodes the three logical outcomes (unchanged re-dispatch, abort, guidance-based re-dispatch) as two labeled options plus the "Other" free-text path. That avoids a two-step flow where a second question only exists to collect free text.

   - Question (single line): `Worker T-<id> exited via stuck-finding detection (attempt <meta.attempts> of <STUCK_REDISPATCH_CAP>). Pick an option below, OR select "Other" and paste guidance text to re-dispatch with a new Decisions entry.`
   - Include in the question body (via the question string itself — `AskUserQuestion` has no separate body field, so append context after a blank line): task title, log path, stuck excerpt from step 2, current Decisions section from step 3.
   - Two labeled options:
     1. **Re-dispatch without changes** — rare, but useful if the human believes the stuck was transient (e.g. Codex flakiness) and wants the same brief re-run.
     2. **Abort (mark blocked)** — give up on this task.
   - The free-text "Other" path is how the human supplies re-dispatch guidance: whatever they type becomes `guidance_text`.
   - `AskUserQuestion`'s response carries both the selected option label and any "Other" notes; the supervisor dispatches on the label first, then treats "Other" + non-empty free text as the guidance path. Empty/whitespace-only "Other" text is explicitly NOT treated as re-dispatch without changes — an empty guidance entry would silently waste the task's one re-dispatch by producing a brief revision with no new information; instead, empty "Other" is re-interpreted as abort (see step 5).
   - If `CHAT_SESSION_ID` is set for the supervisor session (stretch — supervisor sessions do not register with the broker in M5 MVP, so this path is currently dormant; kept as a forward hook), `chat_send` the same context to Discord concurrently so a remote watcher can see the decision. M5 MVP does NOT block on a Discord reply — the local `AskUserQuestion` is the authoritative gate.

5. **Branch on the human's answer.**

   - **Labeled option "Re-dispatch without changes":** skip the brief revision in step 6 and go directly to step 7 (cleanup) → step 8 (re-dispatch).

   - **Labeled option "Abort (mark blocked)":**
     - Append `<task_id>` to `BLOCKED_IDS`.
     - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-aborted"`, `notes: "human aborted after stuck exit — see .ccx/workers/<task_id>.log"`.
     - Audit: `decision: "stuck-abort"`, `source: "human-ask"`, `citation: null`, `reply: null`, `brokerOk: null`.
     - Remove from `RUNNING`. Continue the outer Step B drain loop.

   - **"Other" with non-empty free-text guidance:** the free-text response becomes `guidance_text` and flows into step 6.

   - **"Other" with empty or whitespace-only text:** re-interpret as abort. Stash BOARD-row update with `exit_status: "stuck-aborted"`, `notes: "human selected 'Other' for guidance but supplied empty text — treated as abort"`. Audit entry identical to the Abort path above, citation set to the literal string `"(empty-other-ignored)"` so a later auditor can distinguish a deliberate abort from an empty-other reinterpretation. Remove from `RUNNING`. Continue the outer Step B drain loop.

6. **Append the guidance to the brief.** Read `REPO_ROOT/.ccx/tasks/<task_id>.md` and locate the `## Decisions` section. Two cases:

   - **Section contains only the HTML-comment template** (first-time revision): replace the `<!-- ... -->` block with the new entry.
   - **Section already has `- q:` / `a:` entries** (rare — unused by initial dispatch, but reached if a prior milestone seeded Decisions, or if a task recovered from a `stuck-aborted` state in a previous run that was then manually re-seeded): append the new entry after the last existing one. Preserve prior entries byte-for-byte.

   The new entry:

   ```yaml
   - q: "Stuck finding on attempt <meta.attempts> — <first 80 chars of stuck excerpt, or 'see worker log'>"
     a: |
       <guidance_text, verbatim, indented under the pipe scalar>
   ```

   Use the YAML `|` block scalar so multi-line guidance preserves formatting. Quote the `q:` string; the `a:` block scalar handles embedded quotes/newlines without escaping. If `guidance_text` ends with a trailing newline, keep it — YAML block scalars preserve final newlines by default.

   Commit the revised brief alone:

   ```bash
   git add -- ".ccx/tasks/<task_id>.md"
   git commit -m "supervisor: revise <task_id> brief — M5 stuck recovery (attempt <meta.attempts + 1>)"
   ```

   If the commit fails (pre-commit hook, signing, etc.), DO NOT proceed with re-dispatch. The brief-revision failure means the integration branch cannot record the revised brief, which means the re-dispatched worker's worktree would fork from a `HEAD` that does NOT contain the guidance — silently wasting the re-dispatch. Instead:
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-recovery-failed"`, `notes: "brief revision commit failed: <first 200 chars of git stderr, single-line> — see .ccx/workers/<task_id>.log for original stuck exit"`.
   - Leave the brief file modified on disk (unstaged or staged — depending on where the hook rejected) so the human can inspect. The next supervisor run's P0 clean-tree check will refuse to start until the human resolves the hook and commits or reverts the edit — the same gate M4's Step D commit-failure recovery relies on.
   - Audit: `decision: "stuck-recovery-failed"`, `source: "human-ask"`, `citation: <first 200 chars of git stderr>`, `reply: null`, `brokerOk: null`.
   - Remove from `RUNNING`. Continue the outer Step B drain loop.

7. **Clean the prior worktree and branch.** Before re-spawning, the worker's prior worktree + branch MUST be removed. If left intact, Step A step 1b's stale-artifact gate would fire on the re-dispatch and classify the task as `stale-artifact` blocked — defeating the point of this path. Sequence:

   ```bash
   git worktree remove --force "<REPO_ROOT>-<task_id>" 2>/dev/null
   git branch -D "ccx/<task_id>" 2>/dev/null
   ```

   `--force` is required because `/ccx:loop` in stuck-exit mode does NOT commit its last fix attempt (Phase 4's auto-commit gate blocks on `stuck`), so the worktree may hold uncommitted edits. Those edits are intentionally discarded — they failed Codex review and are captured in the worker log for human inspection. The branch's commit history is similarly discarded from the branch pointer (`git reflog` still holds it for a while if the human wants to recover it manually).

   Verify cleanup succeeded before continuing:

   ```bash
   git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null   # expect non-zero
   test -e "<REPO_ROOT>-<task_id>"                                 # expect non-zero
   ```

   If either artifact still exists (permission denied on worktree directory, branch protection blocking deletion, etc.):
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-cleanup-failed"`, `notes: "worktree or branch cleanup failed — manually remove <REPO_ROOT>-<task_id> and ccx/<task_id>, then re-run supervisor"`.
   - Audit: `decision: "stuck-cleanup-failed"`, `source: "human-ask"`, `citation: null`, `reply: null`, `brokerOk: null`.
   - Remove from `RUNNING`. Continue the outer Step B drain loop. Do NOT attempt re-dispatch with stale artifacts in place.

8. **Re-dispatch.** Reuse Step A steps 4–6 verbatim (capture pre-spawn `STARTED_AT`, spawn, verify-live, persist assigned) with two differences:
   - The `attempts` field in step 6's BOARD update is set to `meta.attempts + 1`, not `1`. Clear `finished_at: null` and `exit_status: null` since this is a fresh attempt.
   - A fresh `STARTED_AT` is captured pre-spawn per Step A step 4's rule; the BOARD row's `started_at` and `RUNNING[<task_id>].started_at` both receive this new value. Capturing pre-spawn is non-negotiable for re-dispatch too: a re-dispatched worker that hits stuck in <3s would otherwise be classified against a post-spawn `started_at`, again filtering out its own closure.
   - The dispatch prompt (§P2.2) is re-assembled from the NOW-revised brief file — `wc -c` on the revised brief picks the inline-vs-read-the-file variant per the existing 4KB escape hatch. The prompt embedding always reads the current file content, so the guidance reaches the worker whether inline-embedded or read-on-demand.

9. **Update `RUNNING[<task_id>]` in place.** Overwrite `shell_id`, `log_path` (same path — `.ccx/workers/<task_id>.log` — which means the re-dispatched worker's output appends to the prior attempt's log; keep this behavior so a human reading the log sees both attempts in order), `started_at` (use the new pre-spawn `STARTED_AT` from step 8), and `attempts: meta.attempts + 1`. Keep `worktree_path`, `branch`, and `scope_include` unchanged (same values, recreated paths). Do NOT remove or re-add `<task_id>` to `DISPATCHED` — same task id, same ownership. Advancing `started_at` is load-bearing: §P2.5's classifier on the NEXT exit uses `at >= started_at` to reject the prior attempt's closure record; leaving the first attempt's `started_at` in place would readmit the prior stuck closure into the scoped set and re-trigger recovery redundantly.

10. **Audit the successful re-dispatch.** Write a final JSONL line: `decision: "stuck-recover"`, `source: "human-ask"`, `citation: <first 200 chars of guidance_text or "(no-change re-dispatch)">`, `reply: <JSON.stringify of guidance_text or null>`, `brokerOk: null`. This closes the loop on the stuck → recover audit trail so P3 can report accurate counts.

11. **Do NOT mark the task as merged or blocked.** It remains `status: "assigned"` on the BOARD, and the newly-spawned worker will be processed by Step B on a later iteration exactly like a first-time dispatch. Continue the outer Step B drain loop to classify other `RUNNING` tasks.

**Re-dispatch log continuity.** The re-dispatched worker writes to the same `.ccx/workers/<task_id>.log` file as the prior attempt. Shell redirection with `>` would truncate the file; the supervisor MUST use `>>` for re-dispatch spawns so both attempts' stdout/stderr are preserved in order. Concretely, Step A step 4's spawn command becomes `... >> ".ccx/workers/<task_id>.log" 2>&1` when the dispatch is a re-dispatch (i.e. when called from §P2.5 step 8). First-time dispatch keeps `>` (the log directory was created in P0 and first-time dispatch should not be appending to a file that shouldn't exist yet — a prior run's stale log would silently concatenate).

**Audit entries.** Reuse the Step B2 JSONL schema from `REPO_ROOT/.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`, with `decision` values extended to include `stuck-recover | stuck-abort | stuck-exhausted | stuck-recovery-failed | stuck-cleanup-failed`. For these entries, the `askId` and `sessionId` fields are `null` (the prompt originated locally from `AskUserQuestion`, not from a worker `chat_ask`), `ageSec` is `0`, `prompt` is the first 200 chars of the stuck excerpt from step 2, `reply` is the guidance text (or null), `brokerOk` is `null`. This keeps all supervisor decisions — M3 autonomous answering plus M5 stuck handling — discoverable by a single `jq '.decision' <SUPERVISOR_RUN_ID>.jsonl` pass.

**What M5 explicitly does NOT do:**

- No automatic brief-Decisions synthesis. M5 always asks the human — the design doc's "revise the brief's Decisions section (from the stuck-finding content)" is deliberately human-mediated because fabricating an answer without judgement was what the worker's own fix attempts already tried and failed.
- No retry without human input. A stuck exit without a human sitting at the supervisor terminal will block on `AskUserQuestion` until the human returns or cancels the supervisor session. Unlike `/ccx:loop` phase 0.7's chat-bridge fallback pattern, the supervisor session is always interactive by contract, so a missing human is a deploy-time error not a runtime case to handle.
- No resume of a stuck-recovered worker from where the prior attempt left off. The re-dispatched worker starts `/ccx:loop` Phase 1 from scratch; prior partial fixes live only in the discarded worktree (recoverable via `git reflog` until gc).

---

## Phase P3: Report

Print a structured final summary:

- **Merged** (`<count>`): list `T-<id>` — `<title>` — `<duration>` — `attempts=<N>` (only when `attempts > 1`; omit the `attempts=` suffix for first-attempt merges to keep the common case clean). `attempts > 1` means the task was re-dispatched after a stuck exit and succeeded on a later attempt — worth surfacing so the human knows the M5 recovery earned its keep.
- **Blocked** (`<count>`): list `T-<id>` — `<exit_status>` — log path (`.ccx/workers/T-<id>.log`) — `attempts=<N>` (suffix only when `N > 1`). Blocked reasons: `stale-artifact | spawn-error | merge-conflict | merge-aborted | merge-commit-failed | no-commit | error | stuck-exhausted | stuck-aborted | stuck-recovery-failed | stuck-cleanup-failed`. M-specific reasons:
  - `merge-aborted` (M4): `git merge --no-commit --no-ff` refused the merge with no unmerged paths (pre-merge-commit hook rejection, branch protection, residual MERGE_HEAD, unreachable object). The supervisor does NOT set `STOP_DISPATCHING` here — failures of this shape are usually per-merge, so the loop keeps draining and other peers can still merge.
  - `merge-commit-failed` (M4): the pre-merge dry-run reported clean but `git commit --no-edit` rejected the merge (typically a pre-commit hook on the integration branch); the supervisor sets `STOP_DISPATCHING` so no new workers spawn, drains existing `RUNNING` peers via Step B, then exits via condition 3. A recovery sidecar at `.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` is written when the same condition is likely to break the Step D batch BOARD commit.
  - `stuck-exhausted` (M5): the task hit `STUCK_REDISPATCH_CAP` stuck exits in a single run. No human prompt fired on the final stuck because the cap gate in §P2.5 step 1 short-circuits it. Inspect `.ccx/workers/T-<id>.log` (both attempts' output is concatenated there per §P2.5's log-continuity rule) and revise the brief's `## Decisions` section manually before re-running the supervisor.
  - `stuck-aborted` (M5): a stuck exit was detected, the human was prompted, and they chose "Abort" (or supplied empty guidance, which the supervisor treats as abort). Log path is the final word; the human already made the call.
  - `stuck-recovery-failed` (M5): the supervisor tried to commit the revised brief after the human supplied guidance but the commit failed (pre-commit hook, signing, branch protection on `.ccx/tasks/`). The brief file is left modified on disk; P0's clean-tree check on the next run forces the human to resolve before a fresh dispatch.
  - `stuck-cleanup-failed` (M5): the prior attempt's worktree or branch could not be removed (permission denied, branch protection blocking `-D`). The re-dispatch was NOT attempted because leaving stale artifacts would trip Step A's stale-artifact gate on the next dispatch. Manually remove the artifacts and re-run.
- **Stranded in `PENDING_POOL`** (informational): tasks whose deps were met but were never dispatched before the loop exited. Report each row with the reason it stayed pending so the human knows what follow-up is needed. Source these reasons from the run-level state (`EVER_DEFERRED_BY_SCOPE`, `STOP_DISPATCHING`, in-memory BOARD `depends_on` resolution) — `DEFERRED_THIS_PASS` is intentionally cleared every A1 pass and is NOT a valid source for P3.
  - `T-<id> — scope-deferred`: `<id>` is in `EVER_DEFERRED_BY_SCOPE`. The M4 scope-overlap gate deferred this task on at least one Step A pass because a `RUNNING` task held an overlapping file set, and no slot ever cleared into a non-overlapping window before the loop exited (typically because `--max-tasks` was reached, `STOP_DISPATCHING` was set, or all conflicting peers merged after this pass's A1 had already moved on). Re-run the supervisor once the conflicting ids merge.
  - `T-<id> — deferred-by-stop-dispatching`: exit condition 3 (M4 — see Step B's merge-commit-failed branch) fired and the loop drained `RUNNING` without dispatching this task. The integration-branch commit pipeline rejected at least one merge commit during the run; resolve the underlying hook/signing/protection issue (see the recovery sidecar referenced below if the run produced one) and re-run the supervisor to pick this task back up.
  - `T-<id> — deps-blocked`: the task's `depends_on` set still points at non-`merged` ids in the in-memory BOARD state at exit. Surface the unmet dep ids; this is the same data the "Not ready (deps unmet)" bullet reports above and is included here for completeness when the same task is also `scope-deferred` or `deferred-by-stop-dispatching`.
- **Not ready (deps unmet)**: list `T-<id>` with its pending deps.
- **Still assigned/running** — only non-empty if the loop exited via `--max-tasks` while workers were still running. Step C waits on RUNNING, so this should stay empty; guard against it in the report anyway.
- **Supervisor audit** (M3 + M5 decisions, when `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` exists): parse every JSONL line in that file (no timestamp filter needed — the per-run filename already isolates this run's decisions from any concurrent supervisor) and summarize counts per `decision` and per `source`. M3 decisions use `decision: "reply" | "escalate"` with `source: "brief" | "direction" | "worker-history" | "none"`; M5 decisions use `decision: "stuck-recover" | "stuck-abort" | "stuck-exhausted" | "stuck-recovery-failed" | "stuck-cleanup-failed"` with `source: "human-ask" | "attempt-cap"`. Group the summary by decision family (M3 ask-handling vs M5 stuck recovery) so the human sees both dimensions at a glance. Also print the in-memory `foreignAsksSkipped` counter — asks this run observed on the broker but did NOT own (another ccx session or not-yet-attributed); a non-zero value is informational, not a failure. Include the absolute path to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can grep it for deeper auditing. If no asks were handled AND no stuck events fired this run (file absent AND no foreign skips), print `no supervisor decisions this run` and move on — absence is not an error. If the run was in Discord-only mode (no supervisor tool surface), note `M3 Step B2 and M5 stuck recovery disabled — broker not in supervisor mode; worker asks reached Discord via broker's auto-escalate and stuck exits were classified as generic no-commit`.

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
| Broker supervisor adapter (worker `chat_ask` interception) | M2 — shipped |
| Autonomous answering from brief `## Decisions` / BOARD direction / merge history | M3 — shipped |
| Scope-glob overlap parallelism gate | M4 — shipped |
| Pre-merge conflict dry-run before committing the merge | M4 — shipped |
| Stuck-exit auto-revise brief and re-dispatch | M5 — shipped |
| Supervisor resume after session close | open |
| Worker budget cap tuning (`--worker-loops` default) | §14 of design doc |

Do not add the deferred rows above to this command — they are tracked separately in `docs/supervisor-design.md`. The current contract is: `BOARD.md` → briefs → dispatch (with scope-overlap gate) → poll completions → drain supervisor asks (autonomous reply or escalate) → pre-merge dry-run → stuck-exit auto-revise + re-dispatch (one chance per task) → BOARD update → audit report.

### How M2 / M3 / M4 / M5 work together at runtime

- M2 ships the broker plumbing (`plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`, `backend: "supervisor"` config option, and the `chat_supervisor_{poll,reply,escalate,close}` MCP tools). With `backend: "supervisor"` in `~/.claude/ccx-chat/config.json`, worker `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60).
- M3 ships the supervisor-side polling (`Step B2`) and the match-confidence rubric (`§P2.3`). When the broker is in Discord-only mode OR the broker tool is unavailable, Step B2 is a no-op and worker asks reach humans via the broker's own 60s auto-escalate timer, preserving the M1 behavior.
- M4 adds two independent gates that share no state: the scope-overlap gate (`Step A2 step 1a` + `§P2.4`) defers candidate dispatches whose `scope.include` shares any tracked file with a `RUNNING` task's snapshotted `scope_include`, and the pre-merge dry-run (`Step B step 3`) wraps every approved-worker merge in a `git merge --no-commit --no-ff` / `git commit --no-edit` pair so conflict detection happens before commit creation. Neither gate touches the audit log or the broker; both are pure repo-state operations.
- M5 adds a closure-status ring buffer to the broker (`chat_supervisor_recent_closures`) plus a per-task stuck-recovery algorithm in the supervisor (`Step B step 4` stuck sub-classifier + `§P2.5`). On a worker's `no-commit` exit, the supervisor peels stuck exits out of the generic bucket by querying the ring buffer; first stuck per task triggers a local `AskUserQuestion` prompt, re-dispatch, and BOARD `attempts` increment; second stuck is terminal (`stuck-exhausted`). If the broker is Discord-only or the new MCP tool is unavailable, M5 degrades silently to M4's no-commit-equals-blocked behavior (`M5_DISABLED = true` run-level flag).
- The audit log (`.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`) is append-only JSONL, owned by the supervisor session, and committed by the supervisor's Step D batch commit alongside `BOARD.md`. M3 decisions (`decision: "reply" | "escalate"`) and M5 decisions (`decision: "stuck-recover" | "stuck-abort" | "stuck-exhausted" | "stuck-recovery-failed" | "stuck-cleanup-failed"`) share the file and are distinguishable by decision family. **Add `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` to the Step D staging set** so the run's decisions land on the integration branch atomically with the merge/block outcomes. Never truncate the file; never edit past lines.
