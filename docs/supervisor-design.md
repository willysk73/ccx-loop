# ccx Supervisor — Design

Status: draft (2026-04-17)
Scope: add a `/ccx:supervisor` slash command to the existing `ccx` plugin so one human can drive N parallel `/ccx:loop` workers from a single repository.

---

## 1. Goal

A single repository maintains a `HANDOFF.md` file that captures pending tasks and direction. A **supervisor session** reads that file, dispatches up to N tasks in parallel to independent **worker sessions** (each running `/ccx:loop --worktree --commit --chat` inside its own git worktree), waits for completion, merges approved branches into the integration branch, and updates `HANDOFF.md`. When workers need a judgement call mid-run they first ask the supervisor; the supervisor answers autonomously if the answer is already in the repo / docs / task spec, and only escalates to a human via Discord when it is not.

Non-goals: distributed execution across machines, long-lived background supervision without a human session open, replacing `/ccx:loop` itself.

---

## 2. Architecture

```
                    ┌─────────────────────────────┐
                    │   supervisor session        │
                    │   (/ccx:supervisor)         │
                    │   - reads HANDOFF.md        │
                    │   - dispatches workers      │
                    │   - merges approved work    │
                    └──────────┬──────────────────┘
                               │ Bash(run_in_background)
                               │ claude -p /ccx:loop ...
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
    ┌───────────┐       ┌───────────┐       ┌───────────┐
    │ worker T-1│       │ worker T-2│       │ worker T-3│
    │ worktree  │       │ worktree  │       │ worktree  │
    │ ccx/T-1   │       │ ccx/T-2   │       │ ccx/T-3   │
    └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
          │                   │                   │
          └─── chat_ask ──────┴─── chat_send ─────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │  ccx-chat       │
                     │  broker         │
                     │  (Unix socket)  │
                     └────────┬────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ supervisor      │
                     │ adapter (new)   │
                     └────────┬────────┘
                              │ autonomous? answer directly
                              │ escalate? forward to...
                              ▼
                     ┌─────────────────┐
                     │ discord adapter │
                     │ (existing)      │
                     └─────────────────┘
```

---

## 3. Spawn mechanism — `claude -p` as background subprocess

The supervisor launches each worker via `Bash(run_in_background=true)`:

```bash
claude -p \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --output-format stream-json \
  "/ccx:loop --worktree=<TASK_ID> --commit --chat <task description>" \
  > .ccx/workers/<TASK_ID>.log 2>&1
```

Rationale:

- **True process isolation.** Each worker is its own Claude Code session with its own skills, hooks, permission state. A worker that hangs or crashes does not affect the supervisor.
- **Native skill invocation.** Workers execute `/ccx:loop` exactly as a human would run it — no need to inline the body into an Agent prompt.
- **Existing tooling reused.** `/ccx:loop --worktree --commit --chat` already handles isolation, auto-commit gating, and Discord bridging. The supervisor adds orchestration, nothing else.

### 3.1 Flags — why each one

- `--permission-mode bypassPermissions` — `/ccx:loop` issues many `Bash(git …)` / `Bash(codex …)` calls. In `-p` mode a TTY-based prompt cannot resolve, so a stricter mode would block the worker. Blast radius is bounded by `--worktree` (sibling directory on an isolated branch); the worker cannot touch main.
- `--no-session-persistence` — avoids polluting `/resume` history with ephemeral worker runs.
- `--output-format stream-json` — lets the supervisor optionally parse worker events in real time (tool calls, phase transitions) instead of only reading end-of-run logs.

### 3.2 Worker-to-supervisor flags — `/ccx:loop`

Workers are always dispatched with:

- `--worktree=<TASK_ID>` — guarantees per-task working-tree isolation so Codex review diffs do not cross-contaminate.
- `--commit` — auto-commit when the Phase 4 gate passes (approve + zero unresolved + tests pass/na + no stuck). Without this, the commit prompt would fall back to `AskUserQuestion` in `-p` mode and hang.
- `--chat` — routes all `chat_*` calls through the broker so the supervisor can intercept.

### 3.3 Completion detection

Three independent signals. The supervisor treats a worker as terminated when any one fires, then cross-checks the other two for the actual status:

1. **Background shell exit.** `Bash(run_in_background=true)` returns a shell id; the supervisor polls its status. Non-zero exit = worker crashed, missing git state.
2. **`chat_close` status.** `/ccx:loop` calls `chat_close({status: ...})` in a finally block with one of `approved | filtered-clean | stuck | budget-exhausted | aborted | error`. The broker records this per session. Supervisor queries `mcp__ccx-chat__*` (or reads broker state) for the final status.
3. **Branch HEAD presence.** The worktree branch `ccx/<TASK_ID>` exists with a new commit authored by Claude. If `chat_close` says `approved` but no commit exists, the worker lied or crashed after approval; supervisor treats this as error.

---

## 4. `HANDOFF.md` schema

`HANDOFF.md` lives at the repo root. It is both human-editable and supervisor-parseable. Each task is a YAML-frontmatter-like block inside a fenced code block under a `## Tasks` section so the surrounding markdown (rationale, direction, notes) stays free-form.

```markdown
## Direction

Free-form prose describing current project priorities, constraints,
upcoming milestones. The supervisor reads this when deciding task order
and answering worker questions autonomously.

## Tasks

```yaml
- id: T-12
  title: "Add chat color tags to ccx-chat output"
  scope:
    include:
      - plugins/ccx/mcp/ccx-chat/adapters/discord.mjs
    exclude: []
  status: pending            # pending | assigned | review | merged | blocked
  priority: normal           # low | normal | high
  depends_on: []             # other task ids that must be merged first
  decisions:                 # answers the supervisor should give without asking the human
    - q: "library choice for color"
      a: "use chalk (already a dep)"
  worktree: null             # filled in when dispatched
  branch: null
  worker_pid: null
  started_at: null
  finished_at: null
  exit_status: null          # chat_close status
  notes: |
    Optional free-form notes the supervisor can append after merge.
```
```

Schema rules:

- `id` is the **stable key**; supervisor never renames. Used as `--worktree=<id>` name and for file paths.
- `scope.include` is a list of globs. **Two tasks whose scope globs do not overlap can run in parallel**; overlapping scopes are serialized. This is how the supervisor prevents concurrent worktrees from producing conflicting merges.
- `decisions` is the autonomous-answer lookup table. When a worker asks a question whose text matches an entry (semantic match — supervisor reads and judges), the supervisor answers directly and logs the match. Missing entries → escalate to human.
- `status` transitions: `pending → assigned → (review) → merged`. `blocked` is terminal and needs human action.
- `exit_status` mirrors `chat_close`'s status verb so merging logic can key off a single field.

Supervisor writes updates to `HANDOFF.md` itself — edits are atomic (read → modify → write) and committed on the integration branch after each merge.

---

## 5. Escalation flow — worker → supervisor → human

### 5.1 Broker supervisor adapter (path A, chosen)

Add `plugins/ccx/mcp/ccx-chat/adapters/supervisor.mjs` alongside the existing `discord.mjs`. Broker config grows a new backend:

```jsonc
// ~/.ccx-chat/config.json
{
  "backend": "supervisor",
  "supervisor": {
    "socket": "/tmp/ccx-supervisor.sock",
    "fallback": "discord"
  },
  "discord": { /* unchanged */ }
}
```

When `backend: "supervisor"`:

1. Worker calls `chat_ask` via MCP → broker → **supervisor adapter**.
2. Adapter writes the question to `/tmp/ccx-supervisor.sock`. Supervisor session listens.
3. Supervisor receives the event, consults `HANDOFF.md` decisions table + task context, decides:
   - **autonomous answer available** → adapter returns `{ reply, source: "supervisor-auto" }`.
   - **escalate** → supervisor calls `chat_ask` on the **Discord adapter** with the question rewrapped (task id, worker branch, original question). Human replies. Supervisor relays the reply back through the socket to the original worker's pending `chat_ask`.
   - **defer/refuse** → adapter returns `{ reply: null, source: "closed" }` and the worker follows its existing `chat_ask` failure path (falls back to `AskUserQuestion`, which fails in `-p`, and the loop aborts cleanly).
4. `chat_send` (one-way status messages from workers) gets two behaviors by flag:
   - Per-worker chatter: forwarded to a **single supervisor-scoped thread** in Discord (one thread per task id), not to the top-level channel.
   - Decisions / escalations: go to the main channel the human watches.

### 5.2 Why keep the broker

The existing broker already handles Unix-socket IPC, session registry, ask/reply correlation, and timeouts. The supervisor adapter is a ~200-line file that forwards events; broker core is untouched. Workers remain unchanged — they keep calling `chat_ask` / `chat_send` regardless of backend.

### 5.3 What the supervisor session runs

The supervisor slash command (`/ccx:supervisor`) itself must:

- Start a local listener on `/tmp/ccx-supervisor.sock`.
- Spawn N worker background processes.
- Poll for completion signals (shell exit, chat_close, branch HEAD).
- Handle incoming `chat_ask` forwards: read question, consult `HANDOFF.md`, reply or escalate.
- Drive the integration branch: on approved worker completion → `git merge --no-ff ccx/<id>` into the integration branch → update `HANDOFF.md` → commit.

The socket listener is the trickiest part. Two viable implementations:

- **(a) Inline Node from Bash.** Spawn a Node child via `node -e '…'` once at command start; it reads socket lines and appends them to a file the supervisor tail-reads. Simple, no long-lived state, dies with the supervisor session.
- **(b) Broker-bundled.** Add a `supervisor-pending.log` mode to the existing broker that appends forwarded questions. Supervisor just reads that file. No new process at all.

(b) is preferred; it reuses the broker's lifecycle management.

---

## 6. Parallel slot management

Supervisor loop (pseudocode):

```
slots = N              # --parallel N, default 3
running = {}           # task_id -> { shell_id, worktree, started_at }

while pending_tasks_exist() or running:
    # 1. Fill slots.
    while len(running) < slots and (task := pick_next_ready_task()):
        dispatch(task)                    # writes .log, updates HANDOFF.md
        running[task.id] = …

    # 2. Drain completions.
    for task_id, meta in list(running.items()):
        if shell_exited(meta.shell_id):
            status = read_chat_close_status(task_id)
            handle_completion(task_id, status)
            del running[task_id]

    # 3. Answer forwarded questions.
    for q in drain_supervisor_socket():
        reply = answer_autonomously(q) or escalate_to_human(q)
        send_reply(q.id, reply)

    sleep_a_bit()                         # 2–5s backoff
```

`pick_next_ready_task()` skips tasks whose scope globs overlap with any currently running task's scope, and whose `depends_on` set is not yet fully `merged`.

`handle_completion(task_id, status)`:

- `approved` / `filtered-clean` → attempt `git merge --no-ff ccx/<id>` into integration branch. On clean merge, mark `status: merged` and update direction notes. On conflict, mark `status: blocked` with conflict details and escalate.
- `stuck` / `budget-exhausted` → mark `status: blocked`, post the worker's last cycle summary to Discord, include the Codex findings that tripped stuck detection, human decides.
- `aborted` / `error` → mark `status: blocked` with the log path.

---

## 7. Merge policy

- **Integration branch** defaults to `main` but `--integration=<branch>` can redirect. Supervisor never force-pushes. Merges are `--no-ff` so each task shows up as one merge commit.
- **Worktree cleanup** is deferred to the human. Supervisor reports the `git worktree remove` commands after merge, following `/ccx:loop`'s existing contract (which also leaves worktrees).
- **Post-merge `HANDOFF.md` update** is a single commit per batch of merges, not per individual merge, to avoid N+1 commits cluttering history. Commit subject: `supervisor: merge T-12, T-15, T-19 — update handoff`.

---

## 8. Permission handling

Supervisor runs in interactive mode (the human is present). Workers run in `-p` with `--permission-mode bypassPermissions`. This is acceptable because:

- Workers only operate inside their worktree (Codex review, Edit/Write, build, test, commit).
- The sibling worktree path is outside the main repo's working tree — a rogue worker cannot touch uncommitted work in the main checkout.
- Workers never call `git push` unless the task description explicitly requests it; `/ccx:loop` Phase 4 does not push by default.
- Network / system-level operations are still constrained by the user's shell environment.

A stricter alternative — `--permission-mode acceptEdits` plus per-repo `.claude/settings.json` allowlist of `Bash(git *) Bash(node *) Bash(npm *) ...` — can replace `bypassPermissions` once the allowlist is tuned. Starting bypass makes the MVP shippable; tightening is a follow-up.

---

## 9. `/ccx:supervisor` command shape

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--dry-run]

--parallel N        max concurrent workers (default 3, clamp 1..10)
--integration B     branch to merge into (default main)
--max-tasks M       stop after M merges even if tasks remain (default unlimited)
--dry-run           parse HANDOFF.md, print dispatch plan, do nothing
```

Phases inside `/ccx:supervisor`:

- **P0 pre-check**: clean tree on integration branch, `HANDOFF.md` parses, broker `backend: supervisor`.
- **P1 plan**: list ready tasks, report the dispatch order, start the main loop described in §6.
- **P2 run**: the scheduling loop, until done or `--max-tasks` reached.
- **P3 report**: final summary (merged / blocked / skipped), pointer to `.ccx/workers/*.log` for each worker.

---

## 10. MVP milestones

1. **M1 — dispatch only.** `/ccx:supervisor` reads `HANDOFF.md`, spawns workers with `claude -p … /ccx:loop --worktree --commit --chat`, polls shell exit, marks status `merged` on `approved` exit (naive merge). No escalation, no socket, no autonomous answering. Human handles any `chat_ask` directly via the existing Discord path.
2. **M2 — supervisor adapter + escalation.** Add `adapters/supervisor.mjs`, broker config gains `backend: "supervisor"`, `/ccx:supervisor` reads forwarded `chat_ask` events and escalates to Discord. Autonomous answering still stubbed — everything escalates.
3. **M3 — autonomous answering.** Supervisor consults `HANDOFF.md` `decisions` tables, prior merge commit messages, and project README/HANDOFF direction to answer without escalating. Log every autonomous answer so the human can audit.
4. **M4 — scope conflict detection.** Scope glob overlap check gates parallelism. Pre-merge conflict dry-run (`git merge --no-commit --no-ff <branch>`, then `git merge --abort`) before committing the merge.
5. **M5 — stuck recovery.** On `stuck` exit, supervisor can optionally re-dispatch with refined task description or a different `--min-severity`.

M1 and M2 are enough to be useful. M3–M5 are quality-of-life.

---

## 11. Open questions

- **Broker singleton vs supervisor scope.** The broker is global (one per host). Can two simultaneous supervisor sessions coexist? Probably not on MVP — require one supervisor at a time, enforce with a lock file.
- **What if the human closes the supervisor session mid-run?** Workers keep running (they're independent processes). On resume (`/ccx:supervisor --resume`), re-read `HANDOFF.md` and reconcile by checking branch HEADs and log tails. Stretch goal.
- **Long-running workers vs budget.** A single worker running `/ccx:forever` inside `-p` has no natural budget cap and can burn tokens indefinitely. Recommendation: supervisor always launches `/ccx:loop --loops N` (not `forever`), with an explicit N, so each worker is bounded.
