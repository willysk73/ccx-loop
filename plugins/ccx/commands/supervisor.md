---
description: "Orchestrate N parallel /ccx:loop workers from BOARD.md — M3: dispatch + autonomous chat_ask answering"
argument-hint: "[--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--dry-run]"
allowed-tools: Bash, BashOutput, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, mcp__ccx-chat__chat_supervisor_poll, mcp__ccx-chat__chat_supervisor_reply, mcp__ccx-chat__chat_supervisor_escalate, mcp__ccx-chat__chat_supervisor_close
---

# /ccx:supervisor — Parallel Worker Orchestrator (M3)

One human drives N parallel `/ccx:loop` workers from a shared `BOARD.md`. Each task runs in its own git worktree, gets its own brief file, and merges back into the integration branch on approval. Worker `chat_ask` calls are intercepted by the broker; the supervisor session answers from the brief / BOARD / merge history when possible, escalating to Discord only when no deterministic answer fits.

Raw arguments: `$ARGUMENTS`

**Milestones shipped** (see §13 of `docs/supervisor-design.md`):

- **M1 — dispatch.** `BOARD.md` → briefs → `claude -p` workers → naive `--no-ff` merge → batch BOARD update.
- **M2 — broker supervisor adapter.** `backend: "supervisor"` in `~/.claude/ccx-chat/config.json` queues worker asks in the broker and exposes `chat_supervisor_{poll,reply,escalate,close}` MCP tools, with a per-ask auto-escalate timer as the no-supervisor-session fallback.
- **M3 — autonomous answering (this milestone).** `/ccx:supervisor` polls the broker's supervisor queue every scheduling iteration. For each pending ask it consults the task brief's `## Decisions` table, BOARD `## Direction`, and the integration branch's merge-commit history. A confident deterministic match → `chat_supervisor_reply`; otherwise → `chat_supervisor_escalate` (human answers on Discord). Every supervisor decision is appended as JSONL to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can audit after the fact.

Still deferred (out of scope for M3):

- Scope-glob overlap detection (M4). If two dispatched tasks touch the same files, merges may conflict; the loop catches conflicts at merge time and marks the task `blocked`, but does not pre-filter dispatch.
- Pre-merge conflict dry-run (M4).
- Stuck-exit auto-revise brief and re-dispatch (M5).
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
2. Validate each task entry. **Required** fields: `id` (string matching `^T-[0-9]+$`), `title` (non-empty string), `status` (one of `pending | assigned | review | merged | blocked`), `scope.include` (non-empty array of strings). **Optional** with defaults: `scope.exclude` (`[]`), `priority` (`normal`, one of `high | normal | low`), `depends_on` (`[]`, array of task ids), `brief` (`.ccx/tasks/<id>.md`), `notes` (`""`). If any task fails validation, STOP and print the offending row(s) verbatim.
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
- `RUNNING = {}` — map `task_id -> { shell_id, worktree_path, branch, log_path, started_at }`
- `DISPATCHED = set()` — every `<TASK_ID>` this supervisor has launched in this run (populated in Step A step 7, never removed). Used by Step B2's ownership filter so asks from workers that exit between ask-time and the next poll are still recognized as ours.
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
7. Write `RUNNING[TASK.id] = { shell_id: SHELL_ID, worktree_path: "<REPO_ROOT>-<TASK.id>", branch: "ccx/<TASK.id>", log_path: ".ccx/workers/<TASK.id>.log", started_at }` AND add `TASK.id` to the `DISPATCHED` set. `DISPATCHED` is never removed from — it's the ownership source of truth for Step B2's filter across the whole run. Remove `<TASK.id>` from `PENDING_POOL`.
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

Sleep 3 seconds (`sleep 3`). Go back to the top of the iteration — **re-evaluate the two exit conditions first** (after A1 recomputes `READY`), then run Steps A → B → B2 in order if neither condition fires. A1 is where newly-unblocked dependents get picked up by a fresh merge; B2 is where supervisor-mode runs drain worker `chat_ask` queues (Discord-only runs skip B2). This iteration shape guarantees the loop cannot spin when either (a) all remaining pending tasks depend on `blocked` predecessors (condition 1 fires once `RUNNING` drains) or (b) `--max-tasks` has been reached with tasks still pending (condition 2 fires once `RUNNING` drains).

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

---

## Phase P3: Report

Print a structured final summary:

- **Merged** (`<count>`): list `T-<id>` — `<title>` — `<duration>`.
- **Blocked** (`<count>`): list `T-<id>` — `<exit_status>` — log path (`.ccx/workers/T-<id>.log`). Blocked reasons: `stale-artifact | spawn-error | merge-conflict | no-commit | error`.
- **Not ready (deps unmet)**: list `T-<id>` with its pending deps.
- **Still assigned/running** — only non-empty if the loop exited via `--max-tasks` while workers were still running. Step C waits on RUNNING, so this should stay empty; guard against it in the report anyway.
- **Supervisor audit** (M3 only, when `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` exists and the run is in supervisor mode): parse every JSONL line in that file (no timestamp filter needed — the per-run filename already isolates this run's decisions from any concurrent supervisor) and summarize counts per `decision` (`reply` / `escalate`) and per `source` (`brief` / `direction` / `worker-history` / `none`). Also print the in-memory `foreignAsksSkipped` counter — asks this run observed on the broker but did NOT own (another ccx session or not-yet-attributed); a non-zero value is informational, not a failure. Include the absolute path to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can grep it for deeper auditing. If no asks were handled this run (file absent AND no foreign skips), print `no worker asks this run` and move on — absence is not an error.

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
| Scope-glob overlap parallelism gate | M4 |
| Pre-merge conflict dry-run before committing the merge | M4 |
| Stuck-exit auto-revise brief and re-dispatch | M5 |
| Supervisor resume after session close | open |
| Worker budget cap tuning (`--worker-loops` default) | §14 of design doc |

Do not add the deferred rows above to this command — they are tracked separately in `docs/supervisor-design.md`. The current contract is: `BOARD.md` → briefs → dispatch → poll completions → drain supervisor asks (autonomous reply or escalate) → naive merge → BOARD update → audit report.

### How M2 and M3 work together at runtime

- M2 ships the broker plumbing (`plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`, `backend: "supervisor"` config option, and the `chat_supervisor_{poll,reply,escalate,close}` MCP tools). With `backend: "supervisor"` in `~/.claude/ccx-chat/config.json`, worker `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60).
- M3 ships the supervisor-side polling (`Step B2`) and the match-confidence rubric (`§P2.3`). When the broker is in Discord-only mode OR the broker tool is unavailable, Step B2 is a no-op and worker asks reach humans via the broker's own 60s auto-escalate timer, preserving the M1 behavior.
- The audit log (`.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`) is append-only JSONL, owned by the supervisor session, and committed by the supervisor's Step D batch commit alongside `BOARD.md`. **Add `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` to the Step D staging set** so the run's decisions land on the integration branch atomically with the merge/block outcomes. Never truncate the file; never edit past lines.
