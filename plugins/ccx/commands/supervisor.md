---
description: "Orchestrate N parallel /ccx:loop workers from BOARD.md — M5 + pre-M6 hotfixes + M7 tier escalation: dispatch + autonomous chat_ask + scope-overlap gate + pre-merge squash + stuck/cap auto-escalate across a 5-rung model ladder + optional Discord presence"
argument-hint: "[--parallel N] [--integration BRANCH] [--max-tasks M] [--worker-loops N] [--max-attempts N] [--start-tier <alias>] [--chat] [--dry-run]"
allowed-tools: Bash, BashOutput, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, mcp__ccx-chat__chat_register, mcp__ccx-chat__chat_send, mcp__ccx-chat__chat_set_phase, mcp__ccx-chat__chat_close, mcp__ccx-chat__chat_supervisor_poll, mcp__ccx-chat__chat_supervisor_reply, mcp__ccx-chat__chat_supervisor_escalate, mcp__ccx-chat__chat_supervisor_close, mcp__ccx-chat__chat_supervisor_recent_closures
---

# /ccx:supervisor — Parallel Worker Orchestrator (M7)

One human drives N parallel `/ccx:loop` workers from a shared `BOARD.md`. Each task runs in its own git worktree, gets its own brief file, and merges back into the integration branch on approval. Worker `chat_ask` calls are intercepted by the broker; the supervisor session answers from the brief / BOARD / merge history when possible, escalating to Discord only when no deterministic answer fits. Tasks whose scope globs touch overlapping files are serialized at dispatch time so concurrent worktrees do not produce conflicting merges, and every merge is staged via a `git merge --squash` dry-run before being finalized as a single supervisor-authored `T-<id>: <title>` commit. When a worker exits without approval, the supervisor automatically re-dispatches the task at a new tier on the fixed 5-rung model ladder — `stuck` bumps one rung, `cycle-cap` (aka `budget-exhausted`) retries the same rung — until either the task merges or the per-task `--max-attempts` budget runs out on the automatic paths. A `stuck` exit at the top of the ladder (`opus/max`) is the only remaining human gate, prompting via the M5 `AskUserQuestion` path; that single branch is exempt from the `--max-attempts` budget (per-event, not latching) so the advertised top-of-ladder human recovery stays reachable under the default configuration while every automatic loop — including cycle-cap retries that may follow a human-directed re-dispatch — remains bounded.

Raw arguments: `$ARGUMENTS`

**Milestones shipped** (see §13 of `docs/supervisor-design.md`):

- **M1 — dispatch.** `BOARD.md` → briefs → `claude -p` workers → naive merge (originally `--no-ff`; switched to `--squash` in pre-M6 §15.1 — see Step B step 3) → batch BOARD update.
- **M2 — broker supervisor adapter.** `backend: "supervisor"` in `~/.claude/ccx-chat/config.json` queues worker asks in the broker and exposes `chat_supervisor_{poll,reply,escalate,close}` MCP tools, with a per-ask auto-escalate timer as the no-supervisor-session fallback.
- **M3 — autonomous answering.** `/ccx:supervisor` polls the broker's supervisor queue every scheduling iteration. For each pending ask it consults the task brief's `## Decisions` table, BOARD `## Direction`, and the integration branch's merge-commit history. A confident deterministic match → `chat_supervisor_reply`; otherwise → `chat_supervisor_escalate` (human answers on Discord). Every supervisor decision is appended as JSONL to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can audit after the fact.
- **M4 — scope-overlap gate + pre-merge dry-run.** Step A defers any pending task whose `scope.include` matches a tracked file already claimed by a `RUNNING` task — overlap is computed by intersecting the two `git ls-files -- <pathspecs>` results plus a literal-glob equality fallback for globs that match no current files. Deferred tasks stay in `PENDING_POOL` and are retried next iteration when slots free; nothing is marked `blocked`. Step B's merge stages the integration branch via `git merge --squash --no-edit` (pre-M6 §15.1 — originally `git merge --no-commit --no-ff --no-edit`), inspects unmerged paths via `git ls-files -u`, and either finalizes with a supervisor-authored `T-<id>: <title>` commit (clean) or rolls back via `git restore --staged --worktree .` (conflict) — separating conflict detection from commit creation.
- **M5 — stuck-exit auto-revise + re-dispatch.** Worker `chat_close({status: "stuck"})` became recoverable in bounded cases. The broker records every `chat_close` status in an in-memory ring buffer (`chat_supervisor_recent_closures` MCP tool); Step B queries it after a `no-commit` classification to peel off stuck exits from the broader cap-hit / filtered-clean / aborted bucket. In M5 the first stuck exit per task prompted the human via `AskUserQuestion`; M7 subsumes that behaviour for all but the terminal `opus/max` rung (see below). See §P2.5.
- **M7 — model tier escalation (this milestone).** Every `claude -p` worker spawn now includes `--model <alias>` and `--effort <level>` drawn from the rung the supervisor currently has the task on. The ladder is fixed at five rungs — `haiku(medium) → sonnet(medium) → opus(high) → opus(xhigh) → opus(max)` — and three new supervisor flags (`--max-attempts N`, `--worker-loops N`, `--start-tier <alias>`) expose the knobs. On worker exit without approval the supervisor reads the `chat_close` status: `stuck` bumps the tier one rung and re-dispatches automatically (no human prompt), `cycle-cap` (the M7 label for `/ccx:loop`'s `budget-exhausted`) retries at the same rung, and both increment the BOARD `attempts` counter. At `opus/max`, stuck falls through to the pre-existing M5 human-guidance `AskUserQuestion` path ("ladder exhausted") — this branch is exempt from `--max-attempts` so the advertised top-of-ladder recovery stays reachable under the default budget; cycle-cap keeps same-rung retrying until `attempts >= --max-attempts`, then blocks with `attempts-exhausted`. `STUCK_REDISPATCH_CAP` from M5 is superseded by `--max-attempts`. BOARD schema and `/ccx:plan` are unchanged — M7 is a supervisor + docs change only. See §P2.5 and `docs/supervisor-design.md` §15.

Still deferred (out of scope for M7):

- `--start-effort` override and per-task BOARD `model_profile` field — deferred to M8 (see `docs/supervisor-design.md` §15.6).
- Supervisor-session resume after close (stretch).

SSOT for all design decisions: `docs/supervisor-design.md`. Read it before editing this command.

---

## Argument Parsing

- `--parallel N` — max concurrent workers. Default: `3`. Clamp `1..10`.
- `--integration BRANCH` — branch merges land on. Default: the supervisor's current branch. Must exist locally.
- `--max-tasks M` — stop accepting new dispatches after M successful merges. Currently-running workers still complete. Default: unlimited.
- `--worker-loops N` — value forwarded to each worker as `/ccx:loop --loops N` (the per-worker review-fix cycle cap). Default: `3` (M7 — see `docs/supervisor-design.md` §15.3). Must be a positive integer in `1..20`; values outside that range are rejected at argument-parse time (see "Validation and defaults" below — do NOT silently clamp). Independent axis from `--max-attempts`: `--worker-loops` bounds cycles inside one worker session, `--max-attempts` bounds how many worker sessions the supervisor spawns for the same task across tiers. `/ccx:loop` is used instead of `/ccx:forever` so every worker has a natural token cap.
- `--max-attempts N` — M7. Bounds the number of **automatic** worker dispatches per task across the full run (tier bumps on `stuck` below `opus/max`, and same-tier retries on `cycle-cap` at any rung). Default: `4` (covers a full automatic ladder climb from the default start tier: `sonnet → opus/high → opus/xhigh → opus/max` — four attempts inclusive). Must be a positive integer; no upper clamp (the human can raise it arbitrarily, but very large values mostly waste budget once cycle-cap retries stop making progress). The counter maps to BOARD's existing `attempts` field — no schema change. Every re-dispatch increments it, including both `stuck` (tier bump) and `cycle-cap` (same tier) paths AND the human-guided opus/max re-dispatch path; M5's narrower "only stuck increments" semantics are superseded. When `attempts >= --max-attempts` and the task is on an automatic path, it blocks with `exit_status: "attempts-exhausted"`. The `opus/max` stuck human-guidance path (§P2.5 step 3) is the SOLE EXEMPTION from this budget gate so that the advertised top-of-ladder human prompt remains reachable under the default configuration: on a pure stuck climb the fourth attempt lands on `opus/max` and, if it too exits stuck, the supervisor asks the human rather than silently blocking on the same count that was sized to allow one full climb. Human-directed re-dispatches still increment `attempts` but bypass the cap; the exemption is per-event (only the immediate stuck → human prompt at opus/max is exempt) and does NOT latch — a subsequent `cycle-cap` exit re-enters the automatic branch and blocks on the cap if it has been exceeded, which keeps every automatic loop bounded.
- `--start-tier <haiku|sonnet|opus|opus-xhigh|opus-max>` — M7. The rung the first attempt runs at. Default: `sonnet`. Must be one of the five rung aliases above (case-sensitive). Subsequent escalations climb from this rung; tiers below `--start-tier` are unreachable for that run. `--start-tier haiku` makes all five rungs reachable in principle — a pure stuck climb walks `haiku → sonnet → opus/high → opus/xhigh → opus/max` — but at the default `--max-attempts 4` the ladder halts at `opus/xhigh` (attempts 1-4) and blocks with `attempts-exhausted` before reaching `opus/max`; pair it with `--max-attempts 5` (or higher) to actually traverse the full ladder and reach the top-rung human-recovery prompt on stuck. `--start-tier opus-max` is a 1-rung "no tier escalation available" run — `cycle-cap` exits become same-tier retries that ARE bounded by `--max-attempts` (the budget gate still applies because cycle-cap is an automatic path), while `stuck` exits go straight to the `opus/max` human-recovery path (§P2.5 step 3) which is the SOLE budget-exempt branch: human-guided re-dispatches at the top rung continue until the human aborts or the worker approves, even past the nominal `--max-attempts`. A subsequent `cycle-cap` after one of those human-guided re-dispatches re-enters the budget-gated automatic branch and blocks if the cap has been exceeded; the budget exemption does NOT carry over to the cycle-cap path.
- `--chat` — pre-M6 §15.3. Register the supervisor session with the `ccx-chat` broker and post lifecycle messages (run start, dispatch, merge, block, stuck prompt, run end) to Discord as fire-and-forget `chat_send` calls. The supervisor never calls `chat_ask` under `--chat` — nothing should queue from the supervisor side; every `AskUserQuestion` stays local. Requires one-time `/ccx:chat-setup`; degrades gracefully if the broker is unreachable (log once, continue without chat). See Phase P0.5.
- `--dry-run` — parse `BOARD.md`, print the dispatch plan, then exit without writing briefs, committing, or spawning workers.

**Validation and defaults** — at argument-parse time, reject the run with a non-zero exit and a precise error message when:

- `--max-attempts` is not a positive integer (`0`, negative, empty, or non-numeric): `--max-attempts must be a positive integer (got: "<value>")`. Silently defaulting a malformed value would surprise the human; make it loud.
- `--worker-loops` is not a positive integer in `1..20`: `--worker-loops must be a positive integer between 1 and 20 (got: "<value>")`. The 20-cap mirrors `/ccx:loop`'s own `--loops` clamp.
- `--start-tier` is not one of `haiku | sonnet | opus | opus-xhigh | opus-max`: `--start-tier must be one of haiku|sonnet|opus|opus-xhigh|opus-max (got: "<value>")`. Do not attempt fuzzy matching; a typo in a ladder alias would silently pick the wrong tier and nothing later would catch it.

All three defaults (`--max-attempts 4`, `--worker-loops 3`, `--start-tier sonnet`) are chosen so that running `/ccx:supervisor` with no flags preserves the pre-M7 cost envelope (first attempt at sonnet/medium) while unlocking automatic ladder escalation on stuck exits.

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
4. Verify `REPO_ROOT/BOARD.md` exists. If missing, STOP with: `BOARD.md not found. Run /ccx:plan "<prompt>" or /ccx:plan --from <path> to seed tasks.` — `/ccx:plan` is the M6 onboarding path (see §14 of `docs/supervisor-design.md`); supervisor does NOT auto-invoke it, because auto-invocation would conflate LLM creativity (decomposition) with deterministic scheduling and hide the human review gate (`status: draft` in planned rows).
5. Create (do NOT fail if present):
   - `REPO_ROOT/.ccx/tasks/`
   - `REPO_ROOT/.ccx/workers/`
   - `REPO_ROOT/.ccx/supervisor-audit/` (per-run M3 audit-log directory; empty until Step B2 writes anything)
5a. **Compute a per-run supervisor ID** `SUPERVISOR_RUN_ID = <UTC-compact-ts>-<rand8>` (e.g. `20260417T153012Z-a3f9c011`). Per-run isolation is required because two concurrent `/ccx:supervisor` runs on the same host each own their own DISPATCHED set but share `REPO_ROOT` — writing both runs' decisions into a single `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` would let either run's Step D commit pick up the other's audit entries. Use `SUPERVISOR_RUN_ID` as the audit filename (Step B2 writes `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`; Step D only stages that exact file; P3 reads that exact file). Do not reuse a prior run's ID.
6. Verify `claude` CLI is on `$PATH`: `command -v claude`. If missing, STOP — the supervisor cannot spawn workers.
7. Check `~/.claude/ccx-chat/config.json`. If missing, WARN (workers with `--chat` will disable chat per `/ccx:loop` Phase 0.7 contract — the supervisor still works, but worker `chat_ask` calls will fall back to `AskUserQuestion` which in `-p` mode aborts the worker cleanly). Do not stop.

If anything fails, print the exact error and stop. No partial setup.

---

## Phase P0.5: Chat bridge setup (only if `--chat` is set)

Pre-M6 §15.3. Registers the supervisor's own ccx-chat session so Discord watchers can see lifecycle events that are otherwise invisible (workers post their own chatter, but from Discord you cannot tell a supervisor run started in repo X, which worker got T-N, or when the run ended).

1. **Tool availability check.** Before calling any `mcp__ccx-chat__*` tool, verify it appears in this session's tool surface (same check §P2 Step B2 performs for `chat_supervisor_poll` and /ccx:loop Phase 0.7 performs for its own chat bridge). If the `ccx-chat` MCP server is not registered — the user has not run `/ccx:chat-setup`, or it failed — `chat_register` is simply absent. Log once to stderr: `--chat requested but ccx-chat MCP server is not available. Run /ccx:chat-setup first. Continuing without chat.` Then unset `--chat` for the rest of the run and proceed. Do NOT abort the supervisor — the user opted into chat, not into blocking on it.

2. **Register the supervisor session.** Call `mcp__ccx-chat__chat_register` with:
   - `label` — `[supervisor] <repo_basename> — <UTC-YYYY-MM-DD HH:MM>Z`. Truncated to ~80 chars by the broker. The `[supervisor]` prefix disambiguates from worker sessions in `/sessions`-style listings; the repo basename mirrors pre-M6 §15.4's broker message prefix (both short, never the absolute path); the UTC timestamp lets the human scroll back through Discord and correlate a session banner to a specific run.
   - `cwd` — `REPO_ROOT` (absolute path; the broker uses `basename(cwd)` to render the repo prefix on every message — matching §15.4 exactly).
   - `branch` — `INTEGRATION` (the supervisor operates on the integration branch by contract — P0 step 2a enforces this).
3. **Store the returned `sessionId` as `CHAT_SESSION_ID`.** On any error from `chat_register` (broker down, Discord 5xx, misconfig), log the error once, leave `CHAT_SESSION_ID` unset, and continue. Every later `chat_send` call gates on `CHAT_SESSION_ID` being truthy, so a register-time failure cleanly degrades to the no-chat path.
4. **Set the initial phase** via `chat_set_phase({sessionId: CHAT_SESSION_ID, phase: "dispatching"})` immediately after register. Later phase transitions: `draining` when `STOP_DISPATCHING` is set or `READY` exhausts while `RUNNING` is non-empty; `closing` at the top of P3. Phase-set failures are logged and ignored — phase is a nice-to-have, not load-bearing.
5. **Degraded-mode handling.** If any later `chat_*` call fails with a non-cancellation error, log the error once, set a run-level `CHAT_DEGRADED = true` flag, and stop attempting further chat calls for the rest of the run to avoid spamming errors. The final P3 report must mention that chat was lost mid-run. Do NOT retry; a broker that dropped one call is unlikely to recover within the same scheduling loop, and retries would just clutter the log.
6. **Cancellation semantics.** Unlike `/ccx:loop`'s `--chat`, the supervisor never calls `chat_ask`, so the `source: "cancel"` path has no trigger. If any `chat_send` call returns an error whose message contains the substring `cancelled` (e.g. `session ab12 was cancelled (user)`), the user issued `!ccx cancel #<id>` from Discord. STOP the supervisor loop immediately without dispatching new workers (set `STOP_DISPATCHING = true` so Step B continues to drain `RUNNING`), skip to P3, and exit via `chat_close({status: "aborted"})`. Do not interpret generic transient errors (network, timeout) as cancellations — only the literal substring `cancelled`.

**Lifecycle messages** — fire-and-forget via `mcp__ccx-chat__chat_send({sessionId: CHAT_SESSION_ID, text: ...})`. All gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`. The broker automatically prepends the color tag, repo prefix (§15.4), and session-id to every body, so the text below should NOT redundantly include the repo name. Each bullet is a separate `chat_send` call — never pack multiple facts onto one line; one fact per bullet renders better in Discord:

| Event | Where fired | `text` body (multi-line; use `\n` between bullets) |
|---|---|---|
| Run start | After P0.5 registration succeeds AND P1's `Proceed` answer returns | `supervisor run started\n• parallel=<N>\n• worker-loops=<N>\n• max-attempts=<N>\n• start-tier=<alias>\n• integration=<branch>\n• pending=<count>\n• ready=<count>\n• deferred-by-deps=<count>` |
| Dispatch | Step A step 8 (right after the one-line stderr dispatch notice); §P2.5 step 6 fires the same shape for every re-dispatch (automatic tier bump, cycle-cap same-tier retry, opus/max human-guided retry) with the updated tier and `attempt=<meta.attempts + 1>` | `dispatched T-<id> — <title>\n• worker session=<sessionId from chat_register inside the worker, if knowable; else "launching">\n• worktree=<REPO_ROOT>-<id>\n• branch=ccx/<id>\n• tier=<alias>/<effort>\n• attempt=<attempts>` |
| Merge | Step B step 3's clean-squash-and-commit outcome | `merged T-<id> — <title>\n• commit=<short SHA>\n• squashed via T-<id>: <title>\n• attempts=<N>\n• final-tier=<alias>/<effort>` |
| Block | Step B step 3/4's any blocked outcome (per-task, including `attempts-exhausted` / `stuck-aborted` / `stuck-recovery-failed` / `stuck-cleanup-failed` — see §P3 for the full exit_status list) | `blocked T-<id> — <exit_status>\n• attempts=<N>\n• final-tier=<alias>/<effort>\n• notes=<first 120 chars of notes>\n• log=.ccx/workers/T-<id>.log` |
| Stuck prompt | §P2.5 step 3(c), just before `AskUserQuestion` opens at `opus/max` (the only rung that still prompts the human; automatic tier-bumps and cycle-cap retries below `opus/max` fire the Dispatch event above, not this one) | `stuck T-<id> — ladder exhausted, human guidance requested\n• attempt=<N> (automatic cap=<MAX_ATTEMPTS>, this branch is exempt)\n• tier=opus/max\n• log=.ccx/workers/T-<id>.log` — render attempt as a bare number with the cap in parentheses, NOT as "<N> of <MAX_ATTEMPTS>", because successive opus/max re-dispatches under human direction can legitimately push `attempts` past `MAX_ATTEMPTS` and "attempt 6 of 4" would misstate the supervisor's state. The lead-in message makes the subsequent `AskUserQuestion`-routed prompt on Discord (via supervisor-mode fallback) legible to a watcher who didn't trigger it |
| Run end | Top of P3, before printing the textual report | `supervisor run complete\n• merged=<N>\n• blocked=<N>\n• stranded=<N>\n• duration=<human-readable>\n• audit=.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl (if written)` |

**Never `chat_ask`.** The supervisor's human gate is always `AskUserQuestion` locally (P1 Proceed, §P2.5 opus/max stuck prompt). `chat_ask` from supervisor would queue in the broker and require the supervisor to poll its own queue, which is not the supervisor's role. Stick to fire-and-forget `chat_send`.

7. **Close the session at P3.** Call `chat_close({sessionId: CHAT_SESSION_ID, status: ...})` exactly once, in a `finally`-style block that runs even when earlier phases threw. Derive `status` in priority order (first match wins):

   1. `aborted` — the human issued `!ccx cancel` (P0.5 step 6 set `STOP_DISPATCHING` via the cancel path).
   2. `error` — an uncaught supervisor error reached the `finally` block.
   3. `stuck` — ANY task ended in a stuck-flavored outcome. A task is stuck-flavored when either of these holds:
      - Its `exit_status` is `stuck-aborted` (unambiguously reached only from the opus/max human-guidance "Abort" path — always stuck).
      - Its `exit_status` is one of `stuck-recovery-failed`, `stuck-cleanup-failed`, or `attempts-exhausted` AND `LAST_SIGNAL_ON_BLOCK[<task_id>] == "stuck"`. These three exit_statuses can each be reached from both stuck-driven and cycle-cap-driven code paths — the brief-revision-commit-failed case is opus/max-only and always stuck, but the cleanup-failed case fires from every re-dispatch path (stuck bump, cycle-cap retry, opus/max human-guided), and attempts-exhausted fires from both automatic paths. The `LAST_SIGNAL_ON_BLOCK` lookup is the sole input that distinguishes the two flavours at session-close time, so the session's stuck nature is preserved only when the final signal leading to the block was genuinely `"stuck"`. Pure cycle-cap drains that happen to hit `stuck-cleanup-failed` are correctly left to rule 5 (`completed`).
   4. `approved` — every dispatched task ended `merged`, and nothing is in flight or blocked.
   5. `completed` — the default for any other mixed merged/blocked outcome, including `attempts-exhausted` or `stuck-cleanup-failed` whose `LAST_SIGNAL_ON_BLOCK` was `"cycle-cap"` (a pure cycle-cap drain with no stuck involvement), plus `merge-*`, `spawn-error`, `no-commit`, etc.

   Because `RUNNING` is drained into `BLOCKED_IDS` or `MERGED_IDS` by the time P3 runs, the `last_signal` values required by rule 3 must be captured BEFORE Step B step 5 removes the task from `RUNNING`. Maintain a per-run `LAST_SIGNAL_ON_BLOCK: { task_id -> "stuck" | "cycle-cap" }` map populated alongside every BOARD-row stash where the exit_status is in `{attempts-exhausted, stuck-recovery-failed, stuck-cleanup-failed}` (§P2.5 step 2, step 4's recovery-failed branch, and step 5's cleanup-failed branch each copy `signal` into it at that moment). Tasks whose exit_status is `stuck-aborted` do NOT need an entry — rule 3's first bullet classifies them directly. P3 reads this map, not `RUNNING`, when computing rule 3.

If `--chat` was unset by step 1's tool-availability check, all seven items above are no-ops.

---

## Phase P1: Parse BOARD.md and plan

1. Read `REPO_ROOT/BOARD.md`. Extract:
   - The `## Direction` section (everything from the line after `## Direction` up to the next `## ` heading or EOF). Store as `DIRECTION_TEXT`. May be empty.
   - The single YAML fenced code block under `## Tasks`. Parse it as a YAML array. If parsing fails or multiple fenced blocks appear under `## Tasks`, STOP with the parse error.
2. Validate each task entry. **Required** fields: `id` (string matching `^T-[0-9]+$`), `title` (non-empty string), `status` (one of `draft | pending | assigned | review | merged | blocked` — `draft` was added in M6 for `/ccx:plan` output and is accepted as a valid status value but is excluded from dispatch in step 3 below), `scope.include` (non-empty array of strings). **Optional** with defaults: `scope.exclude` (`[]`), `priority` (`normal`, one of `high | normal | low`), `depends_on` (`[]`, array of task ids), `brief` (`.ccx/tasks/<id>.md`), `notes` (`""`), `attempts` (`0`, non-negative integer — supervisor-managed counter; under M5 it incremented only on stuck re-dispatch, under M7 it increments on EVERY re-dispatch including both stuck tier-bumps and cycle-cap same-tier retries, and the cap moved from M5's hardcoded `STUCK_REDISPATCH_CAP = 2` to the new `--max-attempts` flag (default `4`). Humans never need to set this, but a missing or null field must be accepted and normalized to `0` so BOARDs authored before M5 continue to parse).

   **Glob-string contract** (used by M4's overlap gate, §P2.4): every entry in `scope.include` and `scope.exclude` MUST be a non-empty string that contains no NUL byte and no newline character — those are the two characters that would break `git ls-files -z` output parsing. All other characters (including single-quote `'`, double-quote `"`, spaces, `$`, backtick) are permitted because §P2.4 mandates exec/argv invocation; single-quote in particular is a legal character in committed Git paths (e.g. `docs/engineer's-guide.md`) and rejecting it would be a regression in accepted task scopes.

   **Pathspec sanity probe** (M4 — runs at validation time, before the dispatch loop starts): for every task whose `status == "pending"`, run `git ls-files -z --` with each glob in `scope.include` AND `scope.exclude` as its own argv element (per §P2.4 step 1's contract — direct exec, no shell). The probe uses Git's pathspec parser without doing anything with the output; its sole purpose is to catch malformed pathspecs deterministically at startup. Any non-zero exit, or stderr matching `bad pathspec` / `unknown pathspec` / `pathspec '...' .* invalid`, fails this task's validation. Without this probe, malformed `:(...)` magic or a stray `\` in a pathspec would only surface inside §P2.4's overlap gate, which defers-and-retries on `git ls-files` failure — turning a bad BOARD row into an infinite supervisor loop because no exit condition fires while `READY` keeps re-including a task that can never dispatch. STOP and print every offending task id with the verbatim git stderr; the human fixes the BOARD row and re-runs.

   If any task fails validation (shape, required-field, glob-string contract, or pathspec sanity probe), STOP and print the offending row(s) verbatim.
3. Compute the two dispatch pools. Both are re-evaluated across the whole run (see P2 Step A1), so treat them as live views rather than frozen snapshots:
   - `PENDING_POOL` — every task with `status == "pending"`. Stays in this pool until the supervisor picks it up.
   - `NOT_READY_REASONS` — for each pending task whose `depends_on` contains any non-`merged` entry, record the unmet deps (for reporting). This is derivation, not filtering.
   Tasks with `status in {draft, assigned, review, blocked, merged}` are excluded from dispatch entirely. `draft` is the `/ccx:plan` output status (M6) — it is the human-review gate: the plan LLM writes drafts, the human reviews and edits, then flips `draft → pending` explicitly before the next supervisor run. Supervisor must NEVER auto-flip `draft → pending`, not even when the row is otherwise complete, because that would bypass the review that §14.3.3 of the design doc is built around.
4. Compute the **initial ready set** `READY` — every task in `PENDING_POOL` whose `depends_on` all resolve to `status == "merged"`. Sort by `priority` descending (`high > normal > low`), breaking ties by `id` ascending treated as a numeric suffix (`T-9` < `T-10`). This ordering is re-applied every time the ready set is recomputed.
5. Print the dispatch plan:
   - `READY` — dispatchable now.
   - `NOT_READY` — waiting on listed deps; will be re-evaluated after each merge.
   - `BLOCKED` / `ASSIGNED` / `REVIEW` — present for visibility; supervisor does not touch these (they need human action or are owned by a prior/concurrent run).
6. If `--dry-run`, stop here.
7. Otherwise call `AskUserQuestion`: "Proceed with dispatch plan?" with options **Proceed** / **Abort**. On Abort, stop with no side effects.
8. On **Proceed**, capture `RUN_STARTED_AT = <UTC ISO 8601>` for P3's run-end duration calculation. Then fire the pre-M6 §15.3 run-start lifecycle message per the table in P0.5 (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`).

---

## Phase P2: Scheduling loop

State:

- `SLOTS = --parallel N`
- `MAX_ATTEMPTS = --max-attempts N` — M7. Bounds the number of **automatic** per-task worker dispatches across the whole run (tier bumps on `stuck` below `opus/max`, same-tier retries on `cycle-cap`), superseding M5's `STUCK_REDISPATCH_CAP`. First dispatch counts as attempt 1; every re-dispatch increments the counter. Once `attempts >= MAX_ATTEMPTS` the automatic paths block the task with `exit_status: "attempts-exhausted"`. The `opus/max` stuck human-guidance path (§P2.5 step 3) is DELIBERATELY EXEMPT from this budget — once the ladder's top is hit and the human is in the loop, their judgement supersedes the automatic cap. This ordering makes the default (`--max-attempts 4`, `--start-tier sonnet`) reachable: four automatic spawns climb to `opus/max`, a fifth (and beyond) may still fire on that rung under explicit human direction without blocking on the numerical budget.
- `WORKER_LOOPS = --worker-loops N` — M7. Forwarded verbatim into the worker spawn as `/ccx:loop --loops <WORKER_LOOPS>`.
- `TIER_LADDER = [ {alias: "haiku", effort: "medium"}, {alias: "sonnet", effort: "medium"}, {alias: "opus", effort: "high"}, {alias: "opus", effort: "xhigh"}, {alias: "opus", effort: "max"} ]` — M7. Fixed 5-rung ladder indexed 0..4 in ascending strength. Each rung is a `(model_alias, effort)` pair passed to `claude -p` as `--model <alias> --effort <effort>`. There is NO config file and NO per-task override — the ladder shape is deterministic across runs (see §15.6 of the design doc for the rejected alternatives). Rung aliases used by `--start-tier` map 1:1 to this index: `haiku → 0`, `sonnet → 1`, `opus → 2`, `opus-xhigh → 3`, `opus-max → 4`. The alias for `--start-tier` uses hyphen separators (`opus-xhigh`, `opus-max`) for CLI ergonomics, but the ladder itself splits model + effort — rung 2/3/4 all share `model == "opus"` and differ only in `effort`. When serializing the rung to the dispatch one-liner, emit `--model <rung.alias> --effort <rung.effort>` with the `alias` field verbatim (`haiku`, `sonnet`, or `opus` — never the hyphenated CLI form).
- `START_TIER` — integer rung index resolved from the `--start-tier` alias at argument-parse time (e.g. `--start-tier sonnet → 1`). Every first-dispatch in this run uses `TIER_LADDER[START_TIER]`.
- `RUNNING = {}` — map `task_id -> { shell_id, worktree_path, branch, log_path, started_at, scope_include, attempts, tier, last_signal }`. `scope_include` is the BOARD row's `scope.include` glob list (a list of strings, copied verbatim at dispatch time), used by Step A's scope-overlap gate to detect which currently-running task already claims the files a candidate task would touch. `attempts` starts at `1` on first dispatch (Step A step 6) and is incremented in place by §P2.5's re-dispatch path; it is the in-memory mirror of the BOARD row's `attempts` field and is used by Step B to enforce `MAX_ATTEMPTS`. `tier` is an integer index into `TIER_LADDER`, initialized to `START_TIER` on first dispatch and updated in place by §P2.5 on re-dispatch (stuck bumps it by 1, cycle-cap leaves it unchanged). `tier` is NOT mirrored onto the BOARD row — M7 is a supervisor + docs change, so BOARD schema stays untouched; on a new supervisor run the task starts fresh at `START_TIER` (the in-memory ladder state is deliberately run-local, so a restart is a clean retry). `last_signal` records the most recent signal value passed into §P2.5 for this task (`"stuck"` or `"cycle-cap"`, or `null` before §P2.5 has ever fired); it is overwritten on every §P2.5 entry and is read at P3 close time to classify the session status (see P0.5 step 7).
- `DISPATCHED = set()` — every `<TASK_ID>` this supervisor has launched in this run (populated in Step A step 7, never removed). Used by Step B2's ownership filter so asks from workers that exit between ask-time and the next poll are still recognized as ours.
- `MERGED_COUNT = 0`
- `MERGED_IDS = []`, `BLOCKED_IDS = []`
- `PENDING_POOL` and `READY` from P1 — treated as live views; recomputed after every completion (see A1 below).
- `DEFERRED_THIS_PASS = set()` — Step A scratch state, cleared at the top of every Step A pass. Tracks which `READY` task ids have already been popped and deferred this pass due to scope-overlap so the inner loop does not re-pop and re-defer the same task indefinitely (popping is destructive — without this set the head of `READY` would be reconsidered until slots fill, masking lower-priority dispatchable tasks behind it).
- `EVER_DEFERRED_BY_SCOPE = set()` — run-level accumulator, NEVER cleared. A1's clear of `DEFERRED_THIS_PASS` is correct for slot-fill scheduling but discards the history P3 needs to classify leftover `PENDING_POOL` entries. Every time A2 step 1a defers a task by scope-overlap, also add its id to `EVER_DEFERRED_BY_SCOPE`. P3 reads this set to attach the `scope-deferred` reason to any task that ends the run still in `PENDING_POOL`. A task that was deferred earlier but eventually dispatched (and then merged or blocked) stays in this set, but P3 ignores it because it is no longer in `PENDING_POOL` at exit — the set is purely a tag, not a status.
- `STOP_DISPATCHING = false` — set to `true` by Step B's merge-commit-failed branch (M4) when the integration-branch commit pipeline rejects a merge commit. While `true`, Step A's slot-fill is skipped entirely so no new workers start, but Step B continues to drain `RUNNING` so already-in-flight peers are not stranded as `assigned`. Loop exit gains a new condition 3 (see below) that fires once `RUNNING` drains, because `READY` may legitimately still hold pending tasks at that point — those tasks are intentionally being left for a future supervisor run after the human resolves the broken commit pipeline.
- `LAST_SIGNAL_ON_BLOCK = {}` — M7. Map `task_id -> "stuck" | "cycle-cap"` populated by §P2.5 immediately before a task is stashed with an exit_status in `{attempts-exhausted, stuck-recovery-failed, stuck-cleanup-failed}` — each of those three statuses can be reached from either the stuck path or the cycle-cap path, so the session-close classifier needs a stored per-task signal to tell them apart. Never cleared during the run (tasks block exactly once). P3's session-close classifier (P0.5 step 7 rule 3) reads it to distinguish a stuck-driven failure (closes session as `stuck`) from a cycle-cap-driven one (closes as `completed`); without this map the `meta.last_signal` that would answer the same question is destroyed by Step B step 5's `RUNNING` removal long before P3 runs. Tasks whose exit_status is `stuck-aborted` do NOT need an entry — that status is only reachable from the opus/max human-guidance abort path and is unambiguously stuck.
- `LAST_OUTPUT_SEEN = {}` — map `shell_id -> byte length of BashOutput buffer at last Step C probe`. Pre-M6 §15.2 — Step C's adaptive polling primitive uses this to detect "a worker produced new output since the last probe" and break out of the 30s wait early. New entries are added by Step A step 7 (initialize to the then-current `BashOutput` length on the first Step C pass after dispatch); entries are removed from `LAST_OUTPUT_SEEN` in Step B step 5 when the task is removed from `RUNNING` so the map cannot grow unbounded across a long run.
- `CHAT_SESSION_ID` and `CHAT_DEGRADED` — pre-M6 §15.3 — set (or not) by P0.5. `CHAT_SESSION_ID` is truthy only when `--chat` was requested, the MCP tool surface was available, AND `chat_register` succeeded. `CHAT_DEGRADED = true` after the first `chat_*` error; once set, all subsequent `chat_send` calls are skipped. Together they gate every lifecycle message below as `if (CHAT_SESSION_ID && !CHAT_DEGRADED) chat_send(...)`.
- `RUN_STARTED_AT` — UTC ISO 8601 captured at the top of P1 after the dispatch plan prints. Used by P3's run-end chat message to compute `duration`. Not load-bearing for any non-chat behavior.

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

   Then spawn the worker with `Bash(run_in_background=true)`. `<TIER.alias>` and `<TIER.effort>` come from `TIER_LADDER[START_TIER]` on first dispatch (step 7 writes `RUNNING[TASK.id].tier = START_TIER`); §P2.5 re-dispatches substitute the updated rung. M7 — every spawn is tier-qualified:

   ```bash
   cd "<REPO_ROOT>" && claude -p \
     --permission-mode bypassPermissions \
     --no-session-persistence \
     --output-format stream-json \
     --model <TIER.alias> \
     --effort <TIER.effort> \
     "$DISPATCH_PROMPT" \
     > ".ccx/workers/<TASK.id>.log" 2>&1
   ```

   `<TIER.alias>` is one of `haiku | sonnet | opus` (NEVER the hyphenated ladder aliases `opus-xhigh` / `opus-max` — those are CLI surface only; the underlying model alias is always `opus` with effort varying). `<TIER.effort>` is one of `medium | high | xhigh | max`. The `--loops <WORKER_LOOPS>` token inside `$DISPATCH_PROMPT` (see §P2.2) is an independent axis — it controls the worker's internal review-fix cycle cap, not the supervisor's attempt count.

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
7. Write `RUNNING[TASK.id] = { shell_id: SHELL_ID, worktree_path: "<REPO_ROOT>-<TASK.id>", branch: "ccx/<TASK.id>", log_path: ".ccx/workers/<TASK.id>.log", started_at: STARTED_AT, scope_include: TASK.scope.include, attempts: 1, tier: START_TIER, last_signal: null }` (reuse the SAME `STARTED_AT` captured in step 4) AND add `TASK.id` to the `DISPATCHED` set. The `scope_include` field is a verbatim copy of the BOARD row's glob list captured at dispatch time — Step A's overlap gate (§P2.4) reads it on every subsequent pass, so it MUST snapshot the value rather than re-read BOARD (a concurrent BOARD edit between dispatch and the next pass would otherwise change the overlap picture under the supervisor). The `attempts` field mirrors the BOARD row's `attempts: 1` just written in step 6; §P2.5 increments both in lockstep on re-dispatch. The `tier` field (M7) is an integer index into `TIER_LADDER` that records which rung this worker was dispatched at; it is NOT mirrored onto the BOARD row (M7 BOARD schema is unchanged) — §P2.5 updates it in place on stuck re-dispatch (`tier + 1`, clamped at `len(TIER_LADDER) - 1`) and leaves it unchanged on cycle-cap re-dispatch. `last_signal` starts at `null`; §P2.5 overwrites it with `signal` on every entry (used at P3 close time to classify session status). `DISPATCHED` is never removed from — it's the ownership source of truth for Step B2's filter across the whole run. Remove `<TASK.id>` from `PENDING_POOL`.
8. Print a one-line dispatch notice: `dispatched <TASK.id> (<TASK.title>) → shell <SHELL_ID>, log <log_path>`. Pre-M6 §15.3 — also fire the dispatch lifecycle `chat_send` per the table in P0.5 (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`). The worker's own chat session id is not yet known at this point — its `/ccx:loop --chat` register call fires later inside the spawned process — so the message uses `launching` as a placeholder. A Discord watcher correlates the worker to this supervisor dispatch by matching `T-<id>` across both messages.

### Step B — Drain completions

For each `(task_id, meta)` in `RUNNING`:

1. Check the background shell status (via `BashOutput` on `meta.shell_id` — inspect whether the shell has terminated and its exit code). If still running, skip this task.
2. If exited, classify the outcome using two repo-state signals (the M1 subset of §4.3 — broker `chat_close` state is currently ignored because the integration-branch commit is the authoritative "approved" signal; adding `chat_close` as a cross-check is a later milestone):

   ```bash
   git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null
   git log "<INTEGRATION>..refs/heads/ccx/<task_id>" --format=%H | head -1
   ```

   - **approved** — exit code 0 AND at least one new commit on `ccx/<task_id>` relative to `INTEGRATION`.
   - **no-commit** — exit code 0 but no new commits. Worker exited via filtered-unapproved, stuck, cycle-cap (M7 — `/ccx:loop`'s `budget-exhausted` status), or user cancellation — `/ccx:loop`'s Phase 4 auto-commit gate correctly blocked the commit. Step 4 below splits this bucket further (M7 sub-classifier peels stuck and cycle-cap into §P2.5; the rest mark `blocked`).
   - **error** — non-zero exit code (crash, invalid args, missing `claude -p`). Mark `blocked`.

3. For **approved**, attempt a **two-step pre-merge dry-run** onto the integration branch using `git merge --squash`. The dry-run stages the merge result into the index + worktree without creating any commit; the supervisor then inspects unmerged paths, asserts the rest of the working tree was clean before the squash, and either finalizes with one supervisor-authored commit (subject `T-<id>: <title>`) or rolls back via `git restore --staged --worktree .`. Squash is preferred over `--no-ff`: `/ccx:loop` Phase 4 squashes its review-fix cycles into a single final commit, so a worker branch is exactly one commit anyway, and a `--no-ff` merge commit would just add a tree-empty graph node. Squash gives the same audit surface (one commit per task on integration, identifiable by its `T-<id>:` subject) without the extra commit:

   ```bash
   # Pre-merge cleanliness assert. The rollback path (`git restore --staged
   # --worktree .`) wipes uncommitted changes wholesale. P0 step 3 already
   # gates on a clean tree at supervisor entry, but a prior Step B iteration
   # could in principle leave artifacts; re-asserting here is load-bearing —
   # if the tree is dirty we MUST refuse this merge entirely (skipping every
   # downstream `git merge --squash` / `git restore` call), classify the task
   # as merge-aborted, and continue with the next RUNNING task. Falling
   # through to `git merge --squash` on a dirty tree means the rollback path
   # would `git restore --staged --worktree .` over the user's unrelated
   # uncommitted edits and silently destroy them.
   PRE_MERGE_DIRTY="$(git status --porcelain)"
   if [ -n "$PRE_MERGE_DIRTY" ]; then
     # Skip the whole squash/commit/rollback block below. Append <task_id> to
     # BLOCKED_IDS, stash BOARD-row update: status: "blocked", exit_status:
     # "merge-aborted", notes: "integration tree dirty before squash —
     # refused to attempt merge (would risk clobbering: <first 200 chars of
     # PRE_MERGE_DIRTY, single-line>)". Do NOT set STOP_DISPATCHING — this
     # is per-merge, not per-supervisor; if every subsequent peer also hits
     # a dirty tree, the recurring pattern surfaces in P3. Then `continue`
     # the outer Step B drain loop. The supervisor MUST NOT execute any of
     # the merge / rollback commands below in this iteration.
     :
   fi

   if git merge --squash --no-edit "ccx/<task_id>"; then
     # Squash succeeded — index + worktree now hold the merged result with
     # NO MERGE_HEAD set (squash never sets MERGE_HEAD). Inspect unmerged
     # paths via `git ls-files -u`; squash skips files with conflicts but
     # surfaces them in the unmerged-paths list rather than aborting.
     UNMERGED="$(git ls-files -u)"
     if [ -z "$UNMERGED" ]; then
       # Clean squash. Finalize as one supervisor-authored commit whose
       # body preserves every worker commit's full message (subject + body),
       # so the M3 Tier-3 worker-history lookup (§P2.3) keeps its citation
       # surface even after squash collapsed the per-cycle commits. Without
       # this, the integration branch would only carry the supervisor's
       # `T-<id>: <title>` subject line and Tier-3 would have nothing to
       # match. `--no-merges` excludes any older `--no-ff` history that
       # might be reachable; `<INTEGRATION>..ccx/<task_id>` scopes to the
       # worker's own commits ahead of integration, in chronological order.
       WORKER_LOG="$(git log --no-merges --reverse --format='--- %h %s%n%b' "<INTEGRATION>..ccx/<task_id>")"
       git commit -m "T-<task_id>: <task_title>" -m "Worker commits squashed into this merge:" -m "$WORKER_LOG"
     else
       # Conflict: capture file list and roll back the staged squash.
       CONFLICT_FILES="$(git ls-files -u | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
       git restore --staged --worktree .
     fi
   else
     # Non-zero from --squash. Two sub-cases share this branch and must be
     # distinguished BEFORE the rollback wipes the unmerged index:
     #   (a) a normal content conflict — squash leaves stage-2/3 entries in
     #       the index AND exits non-zero; this is the common case and must
     #       be classified as `merge-conflict`, not `merge-aborted`.
     #   (b) a true refusal (pre-merge hook rejection, branch protection
     #       blocking the staged write, unreachable object) — no unmerged
     #       paths, exit non-zero; this is `merge-aborted`.
     # Inspect `git ls-files -u` first; only wipe afterwards. The rollback
     # is idempotent regardless of which sub-case we hit.
     UNMERGED="$(git ls-files -u)"
     if [ -n "$UNMERGED" ]; then
       CONFLICT_FILES="$(echo "$UNMERGED" | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
     else
       CONFLICT_FILES=""
     fi
     git restore --staged --worktree .
     # Caller branches on CONFLICT_FILES: non-empty → "Conflict" outcome;
     # empty → "Non-conflict squash refusal" outcome (single in-iteration
     # retry, then merge-aborted if it persists).
   fi
   ```

   Squash semantics relevant to the algorithm above:
   - `git merge --squash` does NOT set `MERGE_HEAD` and does NOT create a commit. There is no `git merge --abort` equivalent because no merge state exists; rollback is `git restore --staged --worktree .`, which reverts the index AND the worktree to `HEAD`. The pre-merge cleanliness assert is what makes that safe — we know there are no other uncommitted changes to lose.
   - File-level conflicts during squash leave the index in a stage-2/3 state (the same `git ls-files -u` surface as a regular merge conflict). The squash exit code is non-zero but the worktree has the conflict markers written; restore wipes both.
   - `git restore --staged --worktree .` is the recommended rollback (preserves branch ref semantics; never moves `HEAD`); `git reset --hard` is rejected because it is more aggressive than needed and would also discard reflog-recoverable state that human triage might want.

   Four outcomes (numbered for clarity; the squash version of M4's conflict-detection-before-commit-creation contract):

   - **Clean squash + commit succeeds** (`git merge --squash` exit 0 AND `git ls-files -u` empty AND `git commit` exit 0 AND `HEAD` moved): `MERGED_COUNT += 1`, append `task_id` to `MERGED_IDS`, stash a BOARD-row update in memory: `status: "merged"`, `finished_at: "<now>"`, `exit_status: "approved"`. Do NOT commit BOARD yet — step D batches all BOARD updates into one commit. The commit subject `T-<task_id>: <task_title>` keeps task identity in the first line of the integration history (replacing what `--no-ff`'s implicit `Merge branch ccx/T-<id>` subject used to provide).
   - **Conflict** (`git ls-files -u` non-empty before the rollback, regardless of whether `git merge --squash` exited 0 or non-zero — both shapes occur in practice: squash exits 0 with stage-2/3 entries when only some paths conflict, and exits non-zero when the conflict prevents finishing). Capture `CONFLICT_FILES` **before** running `git restore` — once restore runs, the unmerged index is gone and `git ls-files -u` returns empty. Use `awk '{print $4}'` (the path column from `ls-files -u`'s stage output) and `sort -u` because conflicted paths appear up to three times (one per stage). Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-conflict"`, `notes: "conflict on <CONFLICT_FILES, comma-separated>"`. The worker branch stays intact — the human resolves manually.
   - **Non-conflict squash refusal** (`git merge --squash` exit non-zero AND `git ls-files -u` empty before the rollback — i.e. `CONFLICT_FILES` came back empty in the else branch above): Git refused the squash for a reason other than file-level conflicts — examples include a `pre-merge-commit` hook rejecting the staged-but-uncommitted state, a branch protection / signed-merge requirement that fails up front, or an unreachable / corrupt object on the worker branch. Some of these are **transient** (`.git/index.lock` released by an exiting peer process, a temporary network blip while resolving the worker branch); others are **permanent** for this run (signed-merge requirement, branch-protection rule, hook that inspects merge content). The supervisor cannot reliably classify these from stderr alone, so it does **one in-iteration retry** before declaring the task permanently blocked.

     Capture the verbatim stderr from the failed `git merge --squash` call (call it `MERGE_STDERR_1`) before running the rollback. The unconditional `git restore --staged --worktree .` above already cleared any partial squash state. Then attempt the merge ONCE more, immediately, in the same Step B iteration:

     ```bash
     # Single in-iteration retry. Any locks that the first restore cleared
     # will not block the retry; permanent rejections will surface again.
     # Both branches inspect `git ls-files -u` BEFORE the rollback so a
     # non-zero exit caused by a content conflict (the common shape) is
     # still classified as merge-conflict, not merge-aborted.
     if git merge --squash --no-edit "ccx/<task_id>"; then
       UNMERGED_2="$(git ls-files -u)"
       if [ -z "$UNMERGED_2" ]; then
         # Same worker-log preservation as the first-attempt clean path
         # above so M3 Tier-3 history scans still hit a worker rationale
         # even when the merge took the retry branch.
         WORKER_LOG="$(git log --no-merges --reverse --format='--- %h %s%n%b' "<INTEGRATION>..ccx/<task_id>")"
         git commit -m "T-<task_id>: <task_title>" -m "Worker commits squashed into this merge:" -m "$WORKER_LOG"
         # Falls into the "Clean squash + commit succeeds" outcome.
       else
         CONFLICT_FILES_2="$(echo "$UNMERGED_2" | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
         git restore --staged --worktree .
         # Falls into the "Conflict" outcome with CONFLICT_FILES_2.
       fi
     else
       MERGE_STDERR_2="<verbatim stderr of the retry's --squash call>"
       UNMERGED_2="$(git ls-files -u)"
       if [ -n "$UNMERGED_2" ]; then
         CONFLICT_FILES_2="$(echo "$UNMERGED_2" | awk '{print $4}' | sort -u | tr '\n' ',' | sed 's/,$//')"
       else
         CONFLICT_FILES_2=""
       fi
       git restore --staged --worktree .
       # CONFLICT_FILES_2 non-empty → "Retry conflicts" outcome below.
       # CONFLICT_FILES_2 empty     → "Retry refuses again" → merge-aborted.
     fi
     ```

     Three terminal states from the retry:
     1. **Retry succeeds** (clean squash + commit): treat exactly like the "Clean squash + commit succeeds" outcome above (`MERGED_COUNT += 1`, append to `MERGED_IDS`, stash `status: "merged" / exit_status: "approved"`). Do NOT add a `notes` entry mentioning the first-attempt failure — the merge is in the integration history at this point; a "we retried" note is reflog territory, not BOARD-row territory.
     2. **Retry conflicts** (`UNMERGED_2` non-empty): the first attempt's transient cause cleared, exposing a real file-level conflict. Treat exactly like the "Conflict" outcome above (`status: "blocked" / exit_status: "merge-conflict" / notes: "conflict on <CONFLICT_FILES_2, comma-separated>"`).
     3. **Retry refuses again** (squash exit non-zero AND `git ls-files -u` empty after rollback): the rejection is permanent for this run. Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-aborted"`, `notes: "git merge --squash refused without conflicts (retried once): <first 200 chars of MERGE_STDERR_2, single-line>"`. Do NOT set `STOP_DISPATCHING` here — `merge-aborted` is per-merge, not per-supervisor; if a subsequent peer's merge also hits the same refusal, the same handler fires again and the human sees a pattern in P3. The worker branch stays intact for manual investigation.

     Why a single in-iteration retry rather than re-queuing for the next Step B iteration: re-queuing would require a new "approved-but-not-yet-merged" state alongside `RUNNING` and `BLOCKED_IDS`, which complicates exit-condition reasoning and could mask a permanent failure as "the supervisor will get to it eventually". A single immediate retry catches the specific transient causes documented above (locks released within milliseconds) without inventing a new state. Failures that need more than seconds to clear are correctly classified as `merge-aborted` and surfaced for human triage.
   - **Clean squash but commit fails** (pre-commit hook rejects the merge, signing failure, etc.): the index + worktree still hold a successful squash result that was never committed. Run `git restore --staged --worktree .` to wipe both back to `HEAD` — leaving the staged squash around would make the next iteration's `git merge --squash` refuse to overlay onto a dirty tree (and the cleanliness assert would refuse first). Append `task_id` to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `exit_status: "merge-commit-failed"`, `notes: "merge squash clean but commit failed — see supervisor stderr"`. Then handle the **likely Step D commit failure** synchronously, before STOPping the run:

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

   The dry-run does NOT replace the abort-on-conflict guarantee — `CONFLICT_FILES` MUST be captured before any rollback. The squash dry-run leaves a bounded "clean merge staged but not yet committed" window; that window MUST be closed by either `git commit -m "T-<task_id>: <task_title>"` (the only intentional persistence path) or `git restore --staged --worktree .` (the rollback) before Step B moves to the next `(task_id, meta)`. Never leave a partial squash state across loop iterations — Step B's own next iteration would observe a dirty integration tree, fail the cleanliness assert, and either refuse the next merge or compound the unfinalized one.

4. For **no-commit**: check whether this was a stuck-finding exit or a cycle-cap exit before marking blocked.

   **M7 recovery sub-classification** (widened from M5's stuck-only path). `/ccx:loop` calls `chat_close({status: "stuck"})` when stuck-finding detection fires, `chat_close({status: "budget-exhausted"})` when it runs out of review-fix cycles without approval (M7 calls this `cycle-cap`), and `chat_close({status: ...})` with other verbs (`filtered-clean`, `aborted`) for the remaining `no-commit` reasons. The supervisor queries the broker's recent-closures ring buffer (populated by the `close()` handler on every `chat_close` call) to distinguish these. If the latest closure record for `branch == "ccx/<task_id>"` shows `status == "stuck"` OR `status == "budget-exhausted"`, hand the task to the §P2.5 recovery algorithm INSTEAD of marking blocked — §P2.5 will decide whether to bump the tier (stuck), retry the same tier (cycle-cap), escalate to the human (ladder exhausted at `opus-max` stuck), or block with `attempts-exhausted` (budget ran out). Any other status — or any failure to query the buffer — falls through to the generic no-commit handling below.

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
       hand off to §P2.5 with signal="stuck" — do NOT fall through
   elif latest != null AND latest.status == "budget-exhausted":
       hand off to §P2.5 with signal="cycle-cap" — do NOT fall through
   else:
       fall through to generic no-commit handling below
   ```

   **Stuck-vs-cap precedence.** When a worker's final three review-fix cycles all shared a single stuck finding AND `--worker-loops` was exhausted, `/ccx:loop` reports the exit as `stuck` (its stuck detector fires first and overrides the budget-exhausted label). The supervisor inherits that decision — the closure record will show `status: "stuck"`, so the first branch above fires and §P2.5 bumps the tier. This is the expected resolution of the ambiguity (see `docs/supervisor-design.md` §15.4) and matches the design doc's "stuck takes precedence" rule.

   **Server-side filter parameters are mandatory for M5 scale.** Pass `cwd`, `branch`, and `since` as shown — do NOT call the tool with an empty params object and filter client-side. The broker's ring buffer can hold up to 8192 entries (24h of closures across every concurrent session on the host); shipping the whole buffer through MCP on every Step B `no-commit` exit would routinely exceed tool/model output budgets, at which point the supervisor's Step B query falls back to the generic no-commit path and M5 silently stops working on realistic workloads. The broker applies these filters identically to the client-side rules described in "Three-dimension scoping" below, so the returned `closures` list is already scoped to this worker's attempt — the supervisor only needs to sort by `at` and pick the tail entry. `limit: 16` is generous for the single-worker single-attempt case (one expected entry) while still tolerating any transient over-reporting.

   **Three-dimension scoping (all required).** The closure ring buffer is broker-wide — shared across every `/ccx:supervisor` and `/ccx:loop` session on the host, and retained in memory across supervisor runs. A loose match would pick up stale entries that have nothing to do with this worker's actual exit. The three filters below are independent and all must apply:

   1. **`cwd == meta.worktree_path`** — the broker is host-global, so two checkouts of different repos (or the same repo under two checkout paths) can each launch a worker whose branch is `ccx/T-1`. Without this filter, a stuck exit in repo A could misclassify a worker in repo B. `meta.worktree_path` was captured at dispatch time (Step A step 7) as the absolute path `<REPO_ROOT>-<task_id>`, which is also exactly the `cwd` that `/ccx:loop --worktree` passes to `chat_register`. Exact-equality on cwd scopes the match to this supervisor's repo unambiguously.

   2. **`branch == "ccx/<task_id>"`** — obvious task-level scoping.

   3. **`at >= meta.started_at`** — closures survive broker restarts within the in-memory ring (they do not survive a broker process restart, but they survive across `/ccx:supervisor` invocations as long as the broker stays alive). A rerun of the same task id after a prior run could otherwise hit an old `stuck` closure from the prior run if the current worker exits `no-commit` without ever calling `chat_close` (broker unreachable, worker crash-before-close, etc.) — the ring buffer would still hold the prior run's `stuck` entry and the classifier would pipe the current fresh `no-commit` into §P2.5 even though THIS attempt never reported stuck. `meta.started_at` was captured at dispatch time (initial: Step A step 6; re-dispatch: §P2.5 step 9's in-place update) and is guaranteed to be later than every closure from a prior attempt or prior run on the same branch. `at` and `started_at` are both UTC ISO 8601 strings — lexicographic comparison is safe because UTC ISO 8601 is monotonic.

   **Latest-match rule (on the scoped set).** After all three filters, the lookup MUST pick the most recent remaining closure and then check `status in {"stuck", "budget-exhausted"}` on THAT single record — NOT scan for any stuck or budget-exhausted entry in the scoped set. After a tier-bump or cycle-cap re-dispatch (§P2.5 step 6) the worker keeps the same branch name `ccx/<task_id>`, so a subsequent non-recovery exit (e.g. the second attempt exits `approved` or `filtered-clean`) appends a fresh closure record alongside the earlier recovery record and both entries pass the cwd/branch/started_at filter. A loose "find any stuck/cap in the scoped set" match would re-route that later exit into §P2.5 even though the live exit was not stuck or cycle-cap, and §P2.5 step 1's budget gate might then misclassify the task. Sorting the scoped set by `at` ascending and taking the tail entry is the contract; equivalently, `max(scopedClosures, key = at)`. The broker preserves insertion order when pushing, so for buffers under the cap this is already `scopedClosures[scopedClosures.length - 1]`; sort explicitly anyway to make the contract robust against future buffer reordering (e.g. if the buffer is ever extended to evict oldest-by-timestamp instead of oldest-by-insertion).

   Rationale for the fallthrough on query failure: M7 recovery is best-effort. If the broker is in Discord-only mode, the `chat_supervisor_recent_closures` tool is unavailable and M7's sub-classifier silently degrades to the M1/M4 behaviour (mark blocked, human handles manually — no tier bump, no same-tier retry). If the tool is available but errors transiently, the task is still correctly classified as `no-commit` — the human loses the auto-escalate convenience for this run but no data is lost.

   **Tool-availability gate.** Before the first query, verify `mcp__ccx-chat__chat_supervisor_recent_closures` is in the session's available tool surface (same check Step B2 performs for `chat_supervisor_poll`). If absent, set a run-level flag `M7_DISABLED = true`, log once `M7 recovery sub-classifier disabled: chat_supervisor_recent_closures tool unavailable`, and skip every subsequent per-task recovery query for the remainder of the run. This mirrors Step B2's `SKIP_B2` pattern — avoid hammering an MCP surface that is definitively missing.

   **Stale-broker degradation (call-time safety net).** Even when the tool IS advertised, a stale detached broker from an older install may be holding the socket — the MCP server can only filter its advertised tool list if the broker's capability probe completed before `listTools` ran. When the supervisor's query errors with a message matching `requires a newer ccx-chat broker` or `unknown op: supervisorRecentClosures` (substring, case-insensitive), treat that as equivalent to the tool being unavailable: set `M7_DISABLED = true`, log once `M7 recovery sub-classifier disabled: ccx-chat broker is out of date — restart it with 'pkill -f ccx-chat/broker.mjs' and re-run the supervisor`, and fall through to the generic no-commit handling for this task (and every subsequent no-commit task this run). Without this recognition, every stuck or cycle-cap worker after an upgrade-server-but-not-restart-broker event would repeatedly re-encounter the same error and mis-classify as generic no-commit with a confusing stderr trail; treating it as `M7_DISABLED` surfaces one clear restart instruction and degrades cleanly. Any OTHER error (timeout, transient IPC drop) remains a per-task fallthrough to no-commit per the existing "Rationale for the fallthrough on query failure" clause — only the stale-broker signatures are sticky.

   **Generic no-commit handling** (reached when the M7 sub-classifier does not trigger): append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "no-commit"`, `notes: "see .ccx/workers/<task_id>.log"`. (`PENDING_POOL` already has this task removed from Step A step 7; the pool-removal rule requires nothing further here.)

   **For error:** append to `BLOCKED_IDS`. Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "error"`, `notes: "see .ccx/workers/<task_id>.log"`. The M7 recovery sub-classifier is NOT consulted for `error` outcomes — a non-zero shell exit means the worker crashed before it could call `chat_close`, so the closure ring buffer has no entry to examine and re-dispatch would almost certainly hit the same crash again.

5. Remove `task_id` from `RUNNING`. Also `delete LAST_OUTPUT_SEEN[meta.shell_id]` so the Step C probe map cannot grow unbounded across a long-running supervisor session (pre-M6 §15.2).
6. Print a one-line completion notice summarizing outcome + duration + log path. Pre-M6 §15.3 — if the task just transitioned to `merged` fire the merge lifecycle `chat_send`; if it transitioned to `blocked` (any `exit_status` including `attempts-exhausted`, `stuck-aborted`, `stuck-recovery-failed`, `stuck-cleanup-failed`, `merge-conflict`, `merge-aborted`, `merge-commit-failed`, `no-commit`, `error`, `stale-artifact`, `spawn-error`) fire the block lifecycle `chat_send`. Both gated on `CHAT_SESSION_ID && !CHAT_DEGRADED` per the table in P0.5. Never emit both for the same task-completion event.

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
      3. **Integration-branch worker-commit history** — `git log "<INTEGRATION>" -n 40 --format='%H%x09%s%x09%b'`. Scan each commit's subject + body for lexical hits on the ask's prompt. Pre-M6 §15.1 switched Step B to `git merge --squash`, so integration history now contains one supervisor-authored commit per task (subject `T-<id>: <title>`) whose body preserves every squashed worker commit's full message (subject + body, in chronological order — see Step B step 3's `WORKER_LOG` interpolation). `--no-merges` is no longer needed (squash produces no merge commits at all) and the worker rationale that Tier 3 needs to cite is present in the squash commit body. Cite the squash commit SHA (first 8 chars) in the reply; the body line that hit can be quoted verbatim. Older history written before §15.1 may still contain `--no-ff` merge commits (empty body, `Merge branch 'ccx/T-<id>'` subject); those are harmless to scan because they will never lexically match a specific ask.

   b. **Decide.**
      - **Confident match** (see §P2.3) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply}`. The reply MUST begin with a one-line source citation — `"From brief Decisions: "`, `"From BOARD direction: "`, or `"From worker-commit <first 8 chars of SHA>: "` — so the worker can push back if the match was wrong.
      - **No confident match** → call `mcp__ccx-chat__chat_supervisor_escalate` with `{askId}`. A human answers on Discord; the reply flows back through the broker automatically.
      - **Explicit refusal** (the ask describes something the brief explicitly forbids, e.g. editing a path outside `scope.include`) → call `mcp__ccx-chat__chat_supervisor_reply` with `{askId, reply: "Refused: <one-sentence reason citing the brief>. Do not proceed — abort via chat_close({status: \"aborted\"}) and surface the blocker in the worker log."}`. Do NOT use `chat_supervisor_close`: that returns `source: "closed"` to the worker, which `/ccx:loop`'s `chat_ask` failure path handles by calling `AskUserQuestion`. Workers dispatched by the supervisor run under `claude -p` where `AskUserQuestion` cannot resolve, so a closed reply would hang the worker or derail it into an aborted cycle. A deterministic refusal reply gives the worker a usable answer it can cite in its own cycle summary.

   c. **Audit.** After the broker tool returns, append ONE JSONL line to `REPO_ROOT/.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`. Field schema (all string fields MUST be valid JSON — pass them through a JSON-string encoder before interpolation so embedded quotes, backslashes, and newlines are escaped; raw heredoc interpolation is FORBIDDEN because worker prompts and supervisor replies routinely contain `"` / `\` / newlines):

      ```json
      {"ts":"<UTC ISO 8601>","askId":"<askId>","taskId":"T-<id>","sessionId":"<sessionId>","ageSec":<ageSec at poll>,"prompt":<JSON.stringify(first 200 chars of prompt)>,"decision":"reply|escalate","source":"brief|direction|worker-history|none","citation":<JSON.stringify(source span / commit SHA / q-text) or null>,"reply":<JSON.stringify(first 200 chars of reply) or null>,"brokerOk":<true|false>}
      ```

      Concrete implementation sketch: build the line with `node -e 'process.stdout.write(JSON.stringify({ts:…, prompt:…, …})+"\n")' >> .ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` or write a small inline `jq -n` expression — either produces valid JSON regardless of input. If the broker call returned `{ok: false}` (ask already resolved by auto-escalate timer or session cancel), still write the audit line with `brokerOk: false` so the trail is complete. Create the log file the first time it is needed; the `.ccx/` directory was created in P0. Never truncate the file; never use `echo "…"` heredoc interpolation for JSON payloads — it cannot safely encode untrusted strings.

### Step C — Adaptive wait

Wait until either (a) at least one worker in `RUNNING` produces new `BashOutput` lines, or (b) 30 seconds have elapsed since entering Step C, whichever happens first. Then go back to the top of the iteration — **re-evaluate all three exit conditions first** (after A1 recomputes `READY`), then run Steps A → B → B2 in order if none of the three conditions fires. A1 is where newly-unblocked dependents get picked up by a fresh merge; B2 is where supervisor-mode runs drain worker `chat_ask` queues (Discord-only runs skip B2). This iteration shape guarantees the loop cannot spin in any of the documented failure modes:
- (a) all remaining pending tasks depend on `blocked` predecessors → condition 1 fires once `RUNNING` drains.
- (b) `--max-tasks` has been reached with tasks still pending → condition 2 fires once `RUNNING` drains.
- (c) `STOP_DISPATCHING` was set by Step B's merge-commit-failed branch (M4) and `PENDING_POOL` still holds untouched tasks → condition 3 fires once `RUNNING` drains. Without checking condition 3 here, A1 keeps `READY` populated from `PENDING_POOL` and the loop would spin forever in this exact failure mode the M4 path is meant to handle.

**Why adaptive polling, not a fixed sleep.** Pre-M6 §15.2 replaced an earlier fixed `sleep 3` with this primitive because (a) Claude Code 2.1.x blocks long standalone leading sleeps, and during e2e the supervisor-LLM sometimes deviated from `sleep 3` and emitted `sleep 30` / `sleep 60` instead, hanging the whole scheduling loop; (b) a fixed 3s cadence wakes the loop 20× per minute even when no worker has produced output, which is wasted LLM budget in the long runtime. The adaptive primitive below is robust to both: any overshoot is naturally capped at 30s, and quiet iterations still cost essentially zero because the supervisor is blocked on `BashOutput` probes rather than re-running Steps A/B/B2.

**Algorithm.** Maintain a per-`shell_id` counter `LAST_OUTPUT_SEEN[shell_id]` across iterations; it is the byte length (or line count — whichever `BashOutput` exposes, use byte length by default) of the worker log the last time Step C inspected it. Initialize new entries to the current `BashOutput` length on the first Step C pass after a dispatch in Step A. On every Step C entry:

1. Record `STEP_C_ENTERED_AT = $(date +%s)` (UTC monotonic wall clock via `date` is adequate — precision within ±1s is fine; the 30s cap is a budget, not a deadline).
2. Inner loop (repeat until a break condition fires):
   a. For each `(task_id, meta)` in `RUNNING`, call `BashOutput` on `meta.shell_id`. If its current output length exceeds `LAST_OUTPUT_SEEN[meta.shell_id]`, update `LAST_OUTPUT_SEEN` to the new length and **break out of Step C immediately** — a worker just produced output and Step B is more likely to find a classifiable completion on the next pass than it was 3 seconds ago.
   b. If `($(date +%s) - STEP_C_ENTERED_AT) >= 30`, break out of Step C — the 30s cap prevents Step C from blocking indefinitely in the (unlikely but possible) case that every `RUNNING` worker is silent for the whole window but also has not exited. Even without new output, Step B might still classify a completion (e.g. a worker exits silently), so revisiting the top of the iteration is the right move.
   c. **Sleep exactly 2 seconds** (`sleep 2`, not 3, not 5, not 30 — the short sleep is mandatory because Claude Code 2.1.x blocks long standalone leading sleeps and because 2s is small enough that the 30s cap is reached in a predictable 15 iterations). Then loop back to step 2a.
3. When `RUNNING == {}`, skip the inner loop entirely — there is no worker to watch. In that case Step C reduces to a single `sleep 2` so the loop still yields cooperatively to the OS scheduler, after which the top-of-iteration exit conditions fire (condition 1 or 3, depending on state).
4. When `SKIP_B2 == false` AND the broker is reachable AND `asks` were pending on the most recent Step B2 poll, prefer a shorter inner-loop cap — break the inner loop after 10 seconds instead of 30. Rationale: a pending ask is work the supervisor owes the worker; the 2s `sleep 2` step gives the broker a chance to return additional asks between polls, but sitting on a 30s cap while workers are waiting on the supervisor for a reply stalls every dispatched worker. This is the only branch that deviates from the 30s ceiling.

**Implementation.** Because Step C runs inside the LLM-driven scheduling loop, each iteration of 2a uses `BashOutput` tool calls (one per `RUNNING` entry), and step 2c uses a `Bash` call with literally `sleep 2` — never a joined sleep like `sleep 30 && ...`. Never issue `sleep` with any value other than `2`. Never issue `sleep` from a wrapper that resolves its own duration from a variable (e.g. `sleep $POLL_INTERVAL`); the harness-level sleep-guard inspects the literal argument, and a variable-resolved duration that happens to be large would still block. Do NOT attempt to replace the inner loop with a single blocking `until` one-liner in shell: that would (a) produce a long-running Bash call the LLM cannot inspect for worker output between probes, and (b) lose the per-iteration `BashOutput` checkpointing that `LAST_OUTPUT_SEEN` needs to avoid over-counting stale output across iterations.

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
- **Tier 3 — Prior task commits on the integration branch (LESS CONFIDENT).** Reply only if a recent commit's subject + body contains a decision that clearly governs the ask. Since pre-M6 §15.1 switched Step B to `git merge --squash`, integration commits from the supervisor take the shape `T-<id>: <title>` with the full chronological worker-commit log preserved in the body (Step B step 3's `WORKER_LOG`). Cite the commit SHA (first 8 chars) and quote the body line that hit. Older `--no-ff` merge commits from pre-§15.1 runs are empty-bodied and will never lexically match — they are harmless to scan. SKIP this tier when the ask is safety-sensitive (touching auth, data migrations, destructive operations, secret handling, network/filesystem permissions) — those always escalate.
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

### P2.5 — M7 tier-escalation and end-of-ladder stuck recovery

Step B step 4's sub-classifier routes here when the broker's recent-closures buffer reports `status == "stuck"` (worker hit `/ccx:loop`'s stuck-finding detector — the same finding `(file, title, body)` recurred across three review cycles) or `status == "budget-exhausted"` (worker ran out of `/ccx:loop --loops` cycles without approval — M7 calls this `cycle-cap`). The supervisor's job here is to decide the next action based on the worker's exit signal and the task's current rung on the fixed 5-rung tier ladder:

- `stuck` below `opus/max` → automatic tier bump, re-dispatch, NO human prompt. Budget-gated: blocks with `attempts-exhausted` when `attempts >= MAX_ATTEMPTS`.
- `cycle-cap` at any rung (including `opus/max`) → same-tier re-dispatch, NO human prompt, NO brief revision. Budget-gated identically — this is critical for keeping automatic retries bounded even when they follow a human-directed re-dispatch.
- `stuck` at `opus/max` → fall through to the M5 `AskUserQuestion` human-guidance path (the only path that still asks the human). EXEMPT from the `--max-attempts` budget so the default (`--max-attempts 4`, `--start-tier sonnet`) is reachable on a pure stuck climb: four automatic spawns reach `opus/max`, and a fifth (or later) may still fire under explicit human direction. The exemption is per-event, not latching — a subsequent `cycle-cap` exit re-enters the automatic branch and obeys the cap.

`/ccx:loop` Phase 2's stuck-finding detection fires when the same finding key recurs across three consecutive Codex review cycles — the worker has tried twice to satisfy Codex and failed. `/ccx:loop`'s Phase 4 reports a distinct `budget-exhausted` status when the review-fix cycle cap was hit without stuck triggering (different findings each cycle). When BOTH would fire (three cycles all sharing one stuck finding AND `--worker-loops` exhausted), `/ccx:loop` picks `stuck` — the supervisor inherits that precedence (see `docs/supervisor-design.md` §15.4, "stuck-vs-cap ambiguity").

Automatic paths (tier bump, same-tier retry) run without blocking the scheduling loop. Only the `opus/max` human-guidance path blocks on `AskUserQuestion`; that is acceptable because (a) reaching `opus/max` stuck at all is rare, (b) other `RUNNING` workers keep executing as subprocesses while the supervisor waits, and (c) the broker's own auto-escalate timer (60s default) is the safety net for any peer worker that emits a `chat_ask` during the wait.

Inputs: `meta = RUNNING[<task_id>]` (with `tier: int`, `attempts: int`, `last_signal: string|null`, and the other fields from Step A step 7), and `signal ∈ {"stuck", "cycle-cap"}` passed from Step B step 4's sub-classifier.

**Entry bookkeeping.** Before running step 1, set `meta.last_signal = signal` (overwrite). This is the value P3 reads to classify the session close when the task eventually blocks with `attempts-exhausted` — without it, a task whose ladder climb was stuck-driven but whose final exit was in the budget-exhausted block would look indistinguishable from a pure cycle-cap drain at session-close time.

**Algorithm:**

Steps 1 and 2 are deliberately ordered **signal dispatch first, budget check second**, and the `opus/max` stuck human-guidance path (step 3) is the SOLE exemption from the `--max-attempts` budget. Other re-dispatches — automatic tier bumps, automatic cycle-cap retries (at any rung, including `opus/max`) — are budget-gated by step 2. The narrow exemption keeps two design promises in tension solvable: (a) the default `--max-attempts 4` covers a full automatic stuck climb from `--start-tier sonnet` and lets the resulting `opus/max` stuck still reach the human prompt rather than being silently swallowed by the cap, AND (b) the bounded automatic recovery cannot loop forever — every cycle-cap path eventually hits the cap, even if interleaved with one or more `opus/max` human-guided re-dispatches that bumped `attempts` past the nominal cap. The human-guided re-dispatches at `opus/max` increment `attempts` but skip step 2; subsequent automatic exits (a fresh cycle-cap, or another stuck below `opus/max` after a hypothetical re-dispatch at a lower rung — which M7 does NOT do, but the rule still defends against future variations) re-enter step 2 and block on the cap. Successive `opus/max` stuck exits keep prompting the human as long as the human keeps re-dispatching; only "abort" or eventual approval terminates that branch.

1. **Signal dispatch — decide the next action from the signal and current rung** (no budget check yet).

   - **`signal == "cycle-cap"`** → automatic path with `next_tier = meta.tier` (retry the same rung; cycle-cap means the review-fix cycle budget was the bottleneck, not model strength). NO brief revision. Continue to step 2 (budget check) → step 5 (cleanup) → step 6 (re-dispatch).

   - **`signal == "stuck"` AND `meta.tier < len(TIER_LADDER) - 1`** (below `opus/max`) → automatic path with `next_tier = meta.tier + 1` (the cheaper rung could not satisfy Codex, so the next rung gets a shot). NO human prompt, NO brief revision — M7's whole point is to automate this response and reserve the human for end-of-ladder. Continue to step 2 (budget check) → step 5 → step 6.

   - **`signal == "stuck"` AND `meta.tier == len(TIER_LADDER) - 1`** (at `opus/max`) → human-guided path. Fall through directly to step 3 (skip step 2 — the budget does NOT gate this branch). `next_tier = meta.tier` regardless of the human's answer (there is no higher rung). The human may pick abort (block `stuck-aborted`), re-dispatch unchanged, or re-dispatch with new Decisions guidance. A human-approved re-dispatch still increments `attempts` on the way out (step 6) — the budget is informational at this point, not enforcing.

2. **Budget check — ONLY on automatic paths** (`signal == "cycle-cap"` OR `signal == "stuck"` below `opus/max`). The opus/max stuck human-guidance path from step 1 skips this step entirely and goes directly to step 3 — that is the sole budget exemption. If `meta.attempts >= MAX_ATTEMPTS`, the task has exhausted the automatic-spawn budget that `--max-attempts` bounds and must block without further spawning. To keep the remediation flow (flip `blocked → pending` and re-run with a higher budget) working in one supervisor run instead of two — Step A step 1b would otherwise fire `stale-artifact` on the next dispatch — perform the same best-effort cleanup that step 5 does BEFORE blocking:
   - Best-effort cleanup: `git worktree remove --force "<REPO_ROOT>-<task_id>" 2>/dev/null` then `git branch -D "ccx/<task_id>" 2>/dev/null`. Rationale: the last attempt exited stuck or cycle-cap without a commit, so there is nothing here the downstream pipeline needs; if the human wants to inspect the attempt, `.ccx/workers/<task_id>.log` (concatenated across every attempt per the log-continuity rule) still holds the full transcript, and `git reflog` preserves the branch pointer for a while. A failure to remove either artifact is NOT fatal on this path — unlike `stuck-cleanup-failed` in step 5, the task is already being blocked; surface the residue in `notes` so the human knows it is there.
   - Verify cleanup: `git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null` (expect non-zero) AND `test -e "<REPO_ROOT>-<task_id>"` (expect non-zero). If either still exists, record that in `cleanup_residue` for the notes string (e.g. `cleanup_residue = "worktree still present at <path>"`); otherwise `cleanup_residue = ""`.
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Let `tier_str = "<TIER_LADDER[meta.tier].alias>/<TIER_LADDER[meta.tier].effort>"` for the notes string.
   - Record `LAST_SIGNAL_ON_BLOCK[<task_id>] = signal` (either `"stuck"` or `"cycle-cap"` depending on which branch of step 1 landed here). This is the sole input P3 uses to distinguish a stuck-driven exhaustion (closes the session as `stuck`) from a cycle-cap-driven one (closes as `completed`) — see P0.5 step 7 rule 3.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "attempts-exhausted"`, `notes: "budget exhausted after <meta.attempts> attempts (last exit: <signal> at tier <tier_str>) — raise --max-attempts, raise --worker-loops, move --start-tier higher, or revise the brief's Decisions section, then flip BOARD status to pending and re-run supervisor.<when cleanup_residue non-empty, append: ' Manual cleanup required first: <cleanup_residue>.'>"`.
   - Audit: `decision: "attempts-exhausted"`, `source: "attempt-cap"`, `citation: "signal=<signal>,tier=<tier_str>,attempts=<meta.attempts>,cleanup_residue=<cleanup_residue or 'none'>"`, `reply: null`, `brokerOk: null`.
   - Remove `<task_id>` from `RUNNING`. Continue the outer Step B drain loop.

   If the budget check passes, proceed to step 5 (cleanup + re-dispatch at `next_tier` from step 1). The human-guided branch from step 1 skipped this step and goes to step 3 directly.

3. **End-of-ladder stuck: ask the human for guidance** (only reached when `signal == "stuck"` AND `meta.tier == len(TIER_LADDER) - 1`). This mirrors M5's original flow; the trigger changed from "first stuck ever" to "stuck at the top of the ladder". The budget never gates this branch — successive `opus/max` stuck exits keep prompting the human as long as the human keeps choosing re-dispatch (each re-dispatch increments `attempts` past the automatic cap; only "abort" or eventual approval terminates the chain).

   a. **Tail the worker log** — read the last ~200 lines of `.ccx/workers/<task_id>.log` and extract any lines referencing "stuck" (case-insensitive) or the finding tuple. `/ccx:loop`'s stuck report is freeform Claude-generated prose, so the supervisor does NOT attempt structured parsing. The tailed excerpt feeds verbatim into the `AskUserQuestion` prompt so the human sees what Codex kept flagging. If the log is unreadable (rare), substitute `(log unavailable — inspect .ccx/workers/<task_id>.log manually)` and proceed.

   b. **Read the brief's current `## Decisions` section** from `REPO_ROOT/.ccx/tasks/<task_id>.md` (first 1500 chars of the section body) so the human sees what has already been seeded before adding another entry.

   c. **Fire the stuck-prompt lifecycle `chat_send`** per the P0.5 table, gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`. The lead-in Discord message makes the subsequent `AskUserQuestion` (which routes to Discord via supervisor-mode fallback) obviously the supervisor's trigger rather than a stray worker ask.

   d. **Ask the human** via a single `AskUserQuestion`. `AskUserQuestion` always exposes an "Other" free-text response alongside the labeled options, so the supervisor encodes the three logical outcomes as two labels plus the free-text path (avoiding a two-step flow):

      - Question (single line): `Worker T-<id> exited stuck at the top of the model ladder (opus/max, attempt <meta.attempts>; automatic --max-attempts cap is <MAX_ATTEMPTS> — this branch is exempt). Pick an option below, OR select "Other" and paste guidance text to re-dispatch with a new Decisions entry.` Phrasing the cap as "automatic ... is N" rather than "attempt N of N" keeps the prompt accurate when prior `opus/max` re-dispatches have already pushed `attempts` past `MAX_ATTEMPTS`; rendering "attempt 6 of 4" would misstate the supervisor's state at exactly the moment the human is being asked to decide.
      - Body (appended after a blank line — `AskUserQuestion` has no separate body field): task title, log path, stuck excerpt from (a), current Decisions section from (b).
      - Two labeled options:
        1. **Re-dispatch without changes** — useful if the human believes the opus/max stuck was transient (Codex flakiness).
        2. **Abort (mark blocked)** — give up on this task.
      - Free-text "Other" path carries `guidance_text`.
      - Empty/whitespace-only "Other" text is NOT treated as re-dispatch without changes — an empty guidance entry would silently waste an attempt by producing a brief revision with no new information; empty "Other" is re-interpreted as abort (see (e)).

   e. **Branch on the human's answer.**

      - **"Re-dispatch without changes":** skip step 4 and go directly to step 5 with `next_tier = meta.tier` (still `opus/max`).
      - **"Abort (mark blocked)":**
        - Append `<task_id>` to `BLOCKED_IDS`.
        - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-aborted"`, `notes: "human aborted after opus/max stuck exit — see .ccx/workers/<task_id>.log"`.
        - Audit: `decision: "stuck-abort"`, `source: "human-ask"`, `citation: null`, `reply: null`, `brokerOk: null`.
        - Remove from `RUNNING`. Continue the outer Step B drain loop.
      - **"Other" with non-empty free-text guidance:** `guidance_text` is non-empty; continue to step 4. `next_tier = meta.tier`.
      - **"Other" with empty or whitespace-only text:** re-interpret as abort. Stash BOARD-row update with `exit_status: "stuck-aborted"`, `notes: "human selected 'Other' for guidance but supplied empty text — treated as abort"`. Audit identical to the abort path above, citation set to the literal string `"(empty-other-ignored)"` so a later auditor can distinguish a deliberate abort from an empty-other reinterpretation. Remove from `RUNNING`. Continue the drain loop.

4. **Append the guidance to the brief** (only reached when step 3(e) produced non-empty `guidance_text`). Read `REPO_ROOT/.ccx/tasks/<task_id>.md`, locate the `## Decisions` section, and decide how to insert:

   - **Section contains only the HTML-comment template** (first-time revision): replace the `<!-- ... -->` block with the new entry.
   - **Section already has `- q:` / `a:` entries** (rare — reached if a prior milestone seeded Decisions, or if the task recovered from a `stuck-aborted` state in a previous run that was then manually re-seeded): append the new entry after the last existing one. Preserve prior entries byte-for-byte.

   The new entry:

   ```yaml
   - q: "Stuck at opus/max on attempt <meta.attempts> — <first 80 chars of stuck excerpt, or 'see worker log'>"
     a: |
       <guidance_text, verbatim, indented under the pipe scalar>
   ```

   Use the YAML `|` block scalar so multi-line guidance preserves formatting. Quote the `q:` string; the `a:` block scalar handles embedded quotes/newlines without escaping. If `guidance_text` ends with a trailing newline, keep it — YAML block scalars preserve final newlines by default.

   Commit the revised brief alone:

   ```bash
   git add -- ".ccx/tasks/<task_id>.md"
   git commit -m "supervisor: revise <task_id> brief — M7 ladder-exhausted recovery (attempt <meta.attempts + 1>)"
   ```

   If the commit fails (pre-commit hook, signing, etc.), DO NOT proceed with re-dispatch. The re-dispatched worker's worktree would fork from a `HEAD` that does NOT contain the guidance, silently wasting the attempt. Instead:
   - **Unstage the failed brief revision immediately** via `git restore --staged -- ".ccx/tasks/<task_id>.md"`. Without this, the brief file stays in the integration-branch index and Step D's subsequent `git add -- BOARD.md` + `git commit` would sweep the abandoned revision into the batch supervisor commit — producing an integration-branch commit that records a brief revision for a task that never actually re-dispatched. The edit itself stays in the worktree (unstaged) so the human can inspect and either commit it manually after fixing the hook or discard it; P0 step 3's clean-tree gate on the next supervisor run will refuse to start until they do one or the other.
   - **Best-effort worktree + branch cleanup** (same pattern as step 2's attempts-exhausted path): `git worktree remove --force "<REPO_ROOT>-<task_id>" 2>/dev/null` then `git branch -D "ccx/<task_id>" 2>/dev/null`, then verify via `git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null` and `test -e "<REPO_ROOT>-<task_id>"`. Without this, after the human fixes the hook/signing problem and flips the BOARD row back to `pending`, the next dispatch would immediately trip Step A step 1b's stale-artifact gate and re-block the task until the human also runs `git worktree remove` / `git branch -D` by hand. Record residue for the `notes` string: `cleanup_residue = "branch ccx/<task_id> still present"` and/or `"worktree still at <REPO_ROOT>-<task_id>"` when either check still sees the artifact; else `cleanup_residue = ""`.
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Record `LAST_SIGNAL_ON_BLOCK[<task_id>] = signal` (here `signal == "stuck"` always, since this path is only reachable from the opus/max stuck branch — still set it explicitly so P3's session-close classifier in P0.5 step 7 rule 3 can apply the same "`LAST_SIGNAL_ON_BLOCK[id] == 'stuck'` → stuck-flavored" rule uniformly across every stuck-derived exit_status).
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-recovery-failed"`, `notes: "brief revision commit failed: <first 200 chars of git stderr, single-line> — unstaged the brief edit; inspect and either commit or discard it, then flip BOARD status to pending and re-run supervisor. See .ccx/workers/<task_id>.log for original stuck exit.<when cleanup_residue non-empty, append: ' Manual worktree/branch cleanup still required: <cleanup_residue>.'>"`.
   - Audit: `decision: "stuck-recovery-failed"`, `source: "human-ask"`, `citation: "brief commit failed: <first 200 chars of git stderr>; cleanup_residue=<cleanup_residue or 'none'>"`, `reply: null`, `brokerOk: null`.
   - Remove from `RUNNING`. Continue the outer Step B drain loop.

   On success, flow reaches step 5 with `next_tier = meta.tier` (already at `opus/max`; no tier change on the human-guidance path).

5. **Clean the prior worktree and branch.** Every path that reaches this step — automatic tier bump, cycle-cap same-tier retry, or human-guidance opus/max re-dispatch — MUST remove the prior worktree + branch before re-spawning; otherwise Step A step 1b's stale-artifact gate would fire on the re-dispatch and classify the task as `stale-artifact` blocked.

   ```bash
   git worktree remove --force "<REPO_ROOT>-<task_id>" 2>/dev/null
   git branch -D "ccx/<task_id>" 2>/dev/null
   ```

   `--force` is required because `/ccx:loop` in stuck or budget-exhausted exit does NOT commit its last fix attempt (Phase 4's auto-commit gate blocks on both statuses), so the worktree may hold uncommitted edits. Those edits are intentionally discarded — they either failed Codex review (stuck) or were not approved within the cycle budget (cycle-cap), and the worker log captures any needed detail for human inspection. The branch's commit history is similarly discarded from the branch pointer (`git reflog` still holds it for a while if the human wants to recover it manually).

   Verify cleanup succeeded before continuing:

   ```bash
   git rev-parse --verify "refs/heads/ccx/<task_id>" 2>/dev/null   # expect non-zero
   test -e "<REPO_ROOT>-<task_id>"                                 # expect non-zero
   ```

   If either artifact still exists (permission denied on worktree directory, branch protection blocking deletion, etc.):
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Let `tier_str = "<TIER_LADDER[meta.tier].alias>/<TIER_LADDER[meta.tier].effort>"`.
   - Record `LAST_SIGNAL_ON_BLOCK[<task_id>] = signal` — the cleanup-failed exit_status is shared between stuck-driven and cycle-cap-driven recovery paths (this step 5 is reached from both), so P3's session-close classifier (P0.5 step 7 rule 3) MUST consult the signal to decide whether the failure was stuck-flavored (close as `stuck`) or cycle-cap-flavored (close as `completed`). Populating the map here uniformly with attempts-exhausted keeps the classifier rule simple and avoids misclassifying a cycle-cap drain as stuck.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "stuck-cleanup-failed"`, `notes: "worktree or branch cleanup failed on re-dispatch (signal=<signal>, tier=<tier_str>) — manually remove <REPO_ROOT>-<task_id> and ccx/<task_id>, then re-run supervisor"`.
   - Audit: `decision: "stuck-cleanup-failed"`, `source: <signal_source>`, `citation: "signal=<signal>,tier=<tier_str>"`, `reply: null`, `brokerOk: null`. Where `<signal_source>` is `"auto"` when reached from the automatic stuck bump or cycle-cap path, and `"human-ask"` when reached from the opus/max human-guidance path.
   - Remove from `RUNNING`. Continue the outer Step B drain loop. Do NOT attempt re-dispatch with stale artifacts in place.

6. **Re-dispatch.** Reuse Step A steps 4–6 (capture pre-spawn `STARTED_AT`, spawn, verify-live, persist `assigned`) with these differences from a first dispatch:
   - The spawn's `--model <alias>` and `--effort <effort>` come from `TIER_LADDER[next_tier]`, not `TIER_LADDER[START_TIER]`. Concretely, substitute `<TIER.alias>` and `<TIER.effort>` in Step A step 4's one-liner with the resolved rung.
   - The log-redirection operator in Step A step 4's spawn command becomes `>>` instead of `>` (re-dispatch log continuity — both attempts' stdout/stderr land in the same `.ccx/workers/<task_id>.log` in order). First-time dispatch keeps `>` so a stale log from a prior run does not silently concatenate. This applies to every re-dispatch path in this section — automatic bump, cycle-cap retry, and opus/max human-guided retry.
   - The `attempts` field in step 6's BOARD update is `meta.attempts + 1`, not `1`. Clear `finished_at: null` and `exit_status: null` since this is a fresh attempt.
   - A fresh `STARTED_AT` is captured pre-spawn per Step A step 4's rule; the BOARD row's `started_at` and `RUNNING[<task_id>].started_at` both receive this new value. Capturing pre-spawn is non-negotiable for re-dispatch too — a re-dispatched worker that hits stuck or budget-exhausted in <3s would otherwise be classified against a post-spawn `started_at` and filter out its own closure, defeating the sub-classifier.
   - The dispatch prompt (§P2.2) is re-assembled from the brief file (revised if step 4 ran, otherwise unchanged); `wc -c` on the current brief picks the inline-vs-read-the-file variant per the existing 4KB escape hatch.
   - The Step A step 8 dispatch `chat_send` (pre-M6 §15.3) fires for the re-dispatch too with `attempt=<meta.attempts + 1>` and the new `tier=<alias>/<effort>`, so a Discord watcher sees the re-spawn is a recovery (tier bump, same-tier retry, or ladder-exhausted re-dispatch) rather than an unrelated new dispatch.

   **Retry-specific spawn-failure handling.** Step A step 5's liveness check can fail on re-dispatch too (a new `--model <alias>` / `--effort <effort>` combination could be rejected by `claude -p`, a config file added mid-run could crash the spawn, disk-full could break the log redirect). Step A's existing spawn-error branch is written for first-time dispatches and would silently leave the stale `RUNNING[<task_id>]` entry from the prior attempt in place — Step B would then keep inspecting a dead shell. Override Step A's spawn-error handling for the §P2.5 re-dispatch path as follows, and skip Step A's first-dispatch clauses (`PENDING_POOL` mutation and `assigned` BOARD commit) entirely:
   - Do NOT commit an `assigned` BOARD update (the Step A step 6 commit never runs because this branch fires before it).
   - **Remove `<task_id>` from `RUNNING`.** This is the key difference from first-dispatch: there IS a stale entry and it MUST be cleared, because the re-dispatch path never touched `PENDING_POOL` (the task was already out of it from the original dispatch).
   - Do NOT touch `PENDING_POOL` — the pool-removal rule was already satisfied by the initial dispatch, and re-adding here would collide with the BOARD update we're about to stash.
   - Append `<task_id>` to `BLOCKED_IDS`.
   - Let `tier_str = "<TIER_LADDER[next_tier].alias>/<TIER_LADDER[next_tier].effort>"` for the notes string.
   - Stash BOARD-row update: `status: "blocked"`, `finished_at: "<now>"`, `exit_status: "spawn-error"`, `notes: "re-dispatch spawn failed at attempt <meta.attempts + 1>, tier <tier_str> — claude -p exited immediately, see .ccx/workers/<task_id>.log"`. Using the same `spawn-error` status as first-dispatch failures keeps the exit-status vocabulary small; the `notes` field distinguishes the re-dispatch case via the attempt/tier suffix.
   - Audit: `decision: "spawn-error"`, `source: <signal_source>`, `citation: "retry spawn failed at <tier_str>, attempt <meta.attempts + 1>"`, `reply: null`, `brokerOk: null`. `<signal_source>` is `"auto"` for tier bumps / cycle-cap retries, `"human-ask"` for opus/max human-guided retries.
   - Continue the outer Step B drain loop. Do NOT retry the spawn this iteration — the same `--model`/`--effort`/config condition would fail again. The human fixes the underlying config and can flip the BOARD row back to `pending` on the next supervisor run.

7. **Update `RUNNING[<task_id>]` in place.** First, capture the pre-update tier into a local variable: `old_tier = meta.tier` (read BEFORE any mutation; step 8's audit branch keys off `old_tier vs next_tier` and would always see them as equal if step 8 ran after the tier was already updated). Then overwrite `shell_id`, `log_path` (same path — `.ccx/workers/<task_id>.log`), `started_at` (the new pre-spawn `STARTED_AT`), `attempts: meta.attempts + 1`, and `tier: next_tier`. Keep `worktree_path`, `branch`, `scope_include`, and `last_signal` (already updated in the entry bookkeeping) unchanged. Do NOT remove or re-add `<task_id>` to `DISPATCHED` — same task id, same ownership. Advancing `started_at` is load-bearing: Step B's sub-classifier on the NEXT exit uses `at >= started_at` to reject the prior attempt's closure record; leaving the first attempt's `started_at` in place would readmit the prior stuck/cap closure into the scoped set and re-trigger recovery redundantly.

8. **Audit the successful re-dispatch.** Write exactly one JSONL line per re-dispatch, picking the `decision` / `source` / `citation` based on which branch of step 2/3 fired. Use `old_tier` (cached in step 7 before the in-place tier mutation) — NOT `meta.tier`, which has already been overwritten with `next_tier`:

   - **Automatic tier bump** (`signal == "stuck"` AND `next_tier > old_tier`): `decision: "tier-escalate"`, `source: "auto"`, `citation: "from <TIER_LADDER[old_tier].alias>/<TIER_LADDER[old_tier].effort> to <TIER_LADDER[next_tier].alias>/<TIER_LADDER[next_tier].effort>"`, `reply: null`, `brokerOk: null`.
   - **Cycle-cap same-tier retry** (`signal == "cycle-cap"`): `decision: "same-tier-retry"`, `source: "auto"`, `citation: "at <TIER_LADDER[old_tier].alias>/<TIER_LADDER[old_tier].effort>"`, `reply: null`, `brokerOk: null`.
   - **Human-guided opus/max re-dispatch** (`signal == "stuck"` AND `old_tier == len(TIER_LADDER) - 1` AND step 3 produced either guidance_text or an unchanged re-dispatch): `decision: "stuck-recover"`, `source: "human-ask"`, `citation: <first 200 chars of guidance_text or "(no-change re-dispatch)">`, `reply: <JSON.stringify of guidance_text or null>`, `brokerOk: null`. (`next_tier == old_tier` on this branch — opus/max is the top of the ladder.)

   The `prompt` field is the first 200 chars of the stuck/cap excerpt from step 3(a) when that step ran, or the literal string `"(auto tier-escalate)"` / `"(auto same-tier retry)"` on the automatic paths that skipped step 3.

9. **Do NOT mark the task as merged or blocked.** It remains `status: "assigned"` on the BOARD, and the newly-spawned worker will be processed by Step B on a later iteration exactly like a first-time dispatch. Continue the outer Step B drain loop to classify other `RUNNING` tasks.

**Re-dispatch log continuity.** The re-dispatched worker writes to the same `.ccx/workers/<task_id>.log` file as the prior attempt. Shell redirection with `>` would truncate; the supervisor MUST use `>>` for re-dispatch spawns so both attempts' stdout/stderr are preserved in order. First-time dispatch keeps `>` (the log directory was created in P0 and first-time dispatch should not be appending to a file that shouldn't exist yet — a prior run's stale log would silently concatenate). Applies identically to every re-dispatch path: tier bump, cycle-cap retry, human-guided opus/max retry.

**Audit entries.** Reuse the Step B2 JSONL schema from `REPO_ROOT/.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`, with `decision` values extended to include `tier-escalate | same-tier-retry | attempts-exhausted | spawn-error | stuck-recover | stuck-abort | stuck-recovery-failed | stuck-cleanup-failed`. `source` values extend to `auto | human-ask | attempt-cap`. For these entries, the `askId` and `sessionId` fields are `null` (the event originated from the supervisor's internal routing, not from a worker `chat_ask`), `ageSec` is `0`, `prompt` is as described in step 8, `reply` is the guidance text (or null), `brokerOk` is `null`. The `spawn-error` decision is reserved for the re-dispatch launch-failure branch in step 6 (`claude -p` rejected the new `--model`/`--effort` combination, crashed at startup, or the log redirect failed); first-dispatch spawn failures land in Step A's existing handler and do NOT write a §P2.5 audit entry. This keeps every supervisor decision — M3 autonomous answering, M7 automatic tier escalation, and the M5-descended opus/max human path — discoverable by a single `jq '.decision' <SUPERVISOR_RUN_ID>.jsonl` pass. Note: M5's `stuck-exhausted` decision value is retired under M7 — the equivalent event is now `attempts-exhausted` with `source: "attempt-cap"`, and the budget cap uses `--max-attempts` rather than the hardcoded `STUCK_REDISPATCH_CAP = 2` that M5 defined.

**What M7 explicitly does NOT do:**

- No descent on the ladder. Tier only ever moves up via stuck bumps or stays the same via cycle-cap. A finished merge followed by another stuck on a different task in the same run does not consider the merged task's tier — each task tracks its own `meta.tier` independently.
- No automatic brief-Decisions synthesis. Automatic tier bumps do NOT touch the brief; only the `opus/max` human-guidance path writes to the `## Decisions` section. Same rationale as M5 had: fabricating an answer without human judgement was what the worker's own fix attempts already tried and failed.
- No per-task model profile. A BOARD row cannot pre-declare its starting tier; every task in the same run starts at the run-level `--start-tier`. Deferred to a future M8 — see `docs/supervisor-design.md` §15.6.
- No `--start-effort` override. Effort is coupled to model in the fixed ladder; overriding effort independently would make the rung model harder to reason about. Deferred — see §15.6.
- No dynamic ladder / config-driven rungs. The five rungs are hardcoded in order. Motivated by the same "deterministic supervisor" property M4 and M5 rely on — a config-driven ladder multiplies failure modes without a clear benefit at this stage.
- No resume of an escalated worker from where the prior attempt left off. The re-dispatched worker starts `/ccx:loop` Phase 1 from scratch; prior partial fixes live only in the discarded worktree (recoverable via `git reflog` until gc).

---

## Phase P3: Report

Pre-M6 §15.3 — before printing the textual summary, fire the run-end lifecycle `chat_send` per the P0.5 table (gated on `CHAT_SESSION_ID && !CHAT_DEGRADED`): merged count, blocked count, stranded count (tasks still in `PENDING_POOL`), duration (`UTC now - RUN_STARTED_AT`, rendered human-readable like `12m34s`), and the audit log path if `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` was written.

Then — also before the textual report — call `mcp__ccx-chat__chat_close({sessionId: CHAT_SESSION_ID, status: <final>})` exactly once. Pick `status` from `approved | completed | stuck | aborted | error` per the rules in P0.5 step 7. This call MUST run in a `finally`-style block so it still fires if an earlier phase threw; if `CHAT_SESSION_ID` was never set (no `--chat`, or registration failed, or the MCP tool was unavailable), skip the close entirely.

Then print a structured textual summary:

- **Merged** (`<count>`): list `T-<id>` — `<title>` — `<duration>` — `attempts=<N>` — `final-tier=<alias>/<effort>` (suffixes only when `attempts > 1`; omit both when the task merged on its first attempt to keep the common case clean). `attempts > 1` means the task was re-dispatched after a stuck or cycle-cap exit and succeeded on a later attempt — worth surfacing so the human knows the M7 ladder escalation earned its keep, and `final-tier` tells them which rung ultimately did the work so they can calibrate `--start-tier` on future runs.
- **Blocked** (`<count>`): list `T-<id>` — `<exit_status>` — log path (`.ccx/workers/T-<id>.log`) — `attempts=<N>` — `final-tier=<alias>/<effort>` (the `attempts=` and `final-tier=` suffixes are only printed when `attempts > 1`; first-attempt blocks skip them). Blocked reasons: `stale-artifact | spawn-error | merge-conflict | merge-aborted | merge-commit-failed | no-commit | error | attempts-exhausted | stuck-aborted | stuck-recovery-failed | stuck-cleanup-failed`. M-specific reasons:
  - `merge-aborted` (M4; algorithm updated to `git merge --squash` by pre-M6 §15.1): `git merge --squash` refused the merge with no unmerged paths (pre-merge-commit hook rejection, branch protection, unreachable object). The supervisor does NOT set `STOP_DISPATCHING` here — failures of this shape are usually per-merge, so the loop keeps draining and other peers can still merge.
  - `merge-commit-failed` (M4): the pre-merge dry-run reported clean but `git commit --no-edit` rejected the merge (typically a pre-commit hook on the integration branch); the supervisor sets `STOP_DISPATCHING` so no new workers spawn, drains existing `RUNNING` peers via Step B, then exits via condition 3. A recovery sidecar at `.ccx/supervisor-recovery-<SUPERVISOR_RUN_ID>.txt` is written when the same condition is likely to break the Step D batch BOARD commit.
  - `attempts-exhausted` (M7): the task consumed its full `--max-attempts` budget across some mix of `stuck` tier-bumps and `cycle-cap` same-tier retries without ever merging. No human prompt fires for this exit — `--max-attempts` is the hard cap by design. The notes field records the last signal, the final tier, and the remediation checklist (raise `--max-attempts`, raise `--worker-loops`, move `--start-tier` higher, or seed the brief's `## Decisions` section). All attempts' output is concatenated in `.ccx/workers/T-<id>.log` per §P2.5's log-continuity rule.
  - `stuck-aborted` (M7 opus/max path): the worker hit stuck at the top of the ladder, the human was prompted, and they chose "Abort" (or supplied empty guidance, which the supervisor treats as abort). Only reachable at `opus/max` — below the top rung the supervisor auto-escalates the tier without prompting. Log path is the final word; the human already made the call.
  - `stuck-recovery-failed` (M7 opus/max path): after the human supplied guidance the supervisor tried to commit the revised brief but the commit failed (pre-commit hook, signing, branch protection on `.ccx/tasks/`). The brief file is left modified on disk; P0's clean-tree check on the next run forces the human to resolve before a fresh dispatch.
  - `stuck-cleanup-failed` (M7 any path): the prior attempt's worktree or branch could not be removed (permission denied, branch protection blocking `-D`). The re-dispatch was NOT attempted because leaving stale artifacts would trip Step A's stale-artifact gate on the next dispatch. Reachable from any recovery path — automatic tier bump, cycle-cap retry, or opus/max human-guided retry. Manually remove the artifacts and re-run.
- **Stranded in `PENDING_POOL`** (informational): tasks whose deps were met but were never dispatched before the loop exited. Report each row with the reason it stayed pending so the human knows what follow-up is needed. Source these reasons from the run-level state (`EVER_DEFERRED_BY_SCOPE`, `STOP_DISPATCHING`, in-memory BOARD `depends_on` resolution) — `DEFERRED_THIS_PASS` is intentionally cleared every A1 pass and is NOT a valid source for P3.
  - `T-<id> — scope-deferred`: `<id>` is in `EVER_DEFERRED_BY_SCOPE`. The M4 scope-overlap gate deferred this task on at least one Step A pass because a `RUNNING` task held an overlapping file set, and no slot ever cleared into a non-overlapping window before the loop exited (typically because `--max-tasks` was reached, `STOP_DISPATCHING` was set, or all conflicting peers merged after this pass's A1 had already moved on). Re-run the supervisor once the conflicting ids merge.
  - `T-<id> — deferred-by-stop-dispatching`: exit condition 3 (M4 — see Step B's merge-commit-failed branch) fired and the loop drained `RUNNING` without dispatching this task. The integration-branch commit pipeline rejected at least one merge commit during the run; resolve the underlying hook/signing/protection issue (see the recovery sidecar referenced below if the run produced one) and re-run the supervisor to pick this task back up.
  - `T-<id> — deps-blocked`: the task's `depends_on` set still points at non-`merged` ids in the in-memory BOARD state at exit. Surface the unmet dep ids; this is the same data the "Not ready (deps unmet)" bullet reports above and is included here for completeness when the same task is also `scope-deferred` or `deferred-by-stop-dispatching`.
- **Not ready (deps unmet)**: list `T-<id>` with its pending deps.
- **Still assigned/running** — only non-empty if the loop exited via `--max-tasks` while workers were still running. Step C waits on RUNNING, so this should stay empty; guard against it in the report anyway.
- **Supervisor audit** (M3 + M7 decisions, when `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` exists): parse every JSONL line in that file (no timestamp filter needed — the per-run filename already isolates this run's decisions from any concurrent supervisor) and summarize counts per `decision` and per `source`. M3 decisions use `decision: "reply" | "escalate"` with `source: "brief" | "direction" | "worker-history" | "none"`; M7 decisions use `decision: "tier-escalate" | "same-tier-retry" | "attempts-exhausted" | "spawn-error" | "stuck-recover" | "stuck-abort" | "stuck-recovery-failed" | "stuck-cleanup-failed"` with `source: "auto" | "human-ask" | "attempt-cap"`. Group the summary by decision family (M3 ask-handling vs M7 tier escalation / end-of-ladder recovery) so the human sees both dimensions at a glance; the `spawn-error` decision specifically flags re-dispatch launch failures (bad `--model`/`--effort` combo, config-file-induced crash, log-redirect failure) and should surface prominently in the summary when it fires, since it indicates a broken escalation the human needs to triage. Also print the in-memory `foreignAsksSkipped` counter — asks this run observed on the broker but did NOT own (another ccx session or not-yet-attributed); a non-zero value is informational, not a failure. Include the absolute path to `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` so the human can grep it for deeper auditing. If no asks were handled AND no stuck/cap events fired this run (file absent AND no foreign skips), print `no supervisor decisions this run` and move on — absence is not an error. If the run was in Discord-only mode (no supervisor tool surface), note `M3 Step B2 and M7 sub-classifier disabled — broker not in supervisor mode; worker asks reached Discord via broker's auto-escalate and stuck/cap exits were classified as generic no-commit`.

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
| Model tier escalation across a 5-rung ladder | M7 — shipped |
| Per-task `model_profile` field in BOARD | M8 — open (see `docs/supervisor-design.md` §15.6) |
| `--start-effort` override and dynamic ladder config | M8 — open (see §15.6) |
| Supervisor resume after session close | open |

Do not add the deferred rows above to this command — they are tracked separately in `docs/supervisor-design.md`. The current contract is: `BOARD.md` → briefs → dispatch (with scope-overlap gate, at the `--start-tier` rung) → poll completions → drain supervisor asks (autonomous reply or escalate) → pre-merge dry-run → on no-commit, peel stuck/cycle-cap from generic via the M7 sub-classifier and re-dispatch at the next rung (stuck) or same rung (cycle-cap) up to `--max-attempts`, asking the human only at `opus/max` stuck → BOARD update → audit report.

### How M2 / M3 / M4 / M5 / M7 work together at runtime

- M2 ships the broker plumbing (`plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs`, `backend: "supervisor"` config option, and the `chat_supervisor_{poll,reply,escalate,close}` MCP tools). With `backend: "supervisor"` in `~/.claude/ccx-chat/config.json`, worker `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60).
- M3 ships the supervisor-side polling (`Step B2`) and the match-confidence rubric (`§P2.3`). When the broker is in Discord-only mode OR the broker tool is unavailable, Step B2 is a no-op and worker asks reach humans via the broker's own 60s auto-escalate timer, preserving the M1 behavior.
- M4 adds two independent gates that share no state: the scope-overlap gate (`Step A2 step 1a` + `§P2.4`) defers candidate dispatches whose `scope.include` shares any tracked file with a `RUNNING` task's snapshotted `scope_include`, and the pre-merge dry-run (`Step B step 3`) wraps every approved-worker merge in a `git merge --squash` + `git commit -m "T-<id>: <title>"` pair (pre-M6 §15.1; originally `git merge --no-commit --no-ff` + `git commit --no-edit`) so conflict detection happens before commit creation. Neither gate touches the audit log or the broker; both are pure repo-state operations.
- M5 originally added a closure-status ring buffer to the broker (`chat_supervisor_recent_closures`) plus a per-task stuck-recovery algorithm in the supervisor (`Step B step 4` stuck sub-classifier + `§P2.5`). M5's `STUCK_REDISPATCH_CAP = 2` and "always ask the human on the first stuck" behaviours are superseded by M7 (see below). The broker-side ring buffer and the `no-commit` peeling step survive unchanged; what changed is the supervisor-side decision tree on top of them.
- M7 widens the M5 sub-classifier to also peel `budget-exhausted` (cycle-cap) exits, attaches a current-rung `tier` field to every `RUNNING` entry, and replaces the M5 human-prompt-on-first-stuck with automatic escalation: `stuck` bumps the tier one rung (or falls through to the M5 human-guidance `AskUserQuestion` path only at `opus/max`); `cycle-cap` retries the same rung; both increment `attempts`. The per-task budget moves from M5's hardcoded `STUCK_REDISPATCH_CAP = 2` to the new `--max-attempts` flag (default `4`); `--worker-loops` (default `3`) and `--start-tier` (default `sonnet`) round out the M7 surface. If the broker is Discord-only or `chat_supervisor_recent_closures` is unavailable, the M7 sub-classifier degrades silently to M4's no-commit-equals-blocked behaviour (`M7_DISABLED = true` run-level flag) — no tier bumps fire and stuck/cap workers are classified as generic no-commit.
- The audit log (`.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl`) is append-only JSONL, owned by the supervisor session, and committed by the supervisor's Step D batch commit alongside `BOARD.md`. M3 decisions (`decision: "reply" | "escalate"`) and M7 decisions (`decision: "tier-escalate" | "same-tier-retry" | "attempts-exhausted" | "spawn-error" | "stuck-recover" | "stuck-abort" | "stuck-recovery-failed" | "stuck-cleanup-failed"`) share the file and are distinguishable by decision family. **Add `.ccx/supervisor-audit/<SUPERVISOR_RUN_ID>.jsonl` to the Step D staging set** so the run's decisions land on the integration branch atomically with the merge/block outcomes. Never truncate the file; never edit past lines.
