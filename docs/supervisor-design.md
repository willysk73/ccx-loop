# ccx Supervisor — Design

Status: draft (2026-04-17)
Scope: add a `/ccx:supervisor` slash command to the existing `ccx` plugin so one human can drive N parallel `/ccx:loop` workers from a single repository.

---

## 1. Goal

A single repository maintains a `BOARD.md` file at its root that captures pending tasks and project direction. A **supervisor session** reads that file, writes a per-task brief under `.ccx/tasks/T-<id>.md` for each task it dispatches, launches up to N independent **worker sessions** (each running `/ccx:loop --worktree --commit --chat` inside its own git worktree), waits for completion, merges approved branches into the integration branch, and updates `BOARD.md`. When workers need a judgement call mid-run they first ask the supervisor through the `ccx-chat` broker; the supervisor answers autonomously if the answer is already in the brief / BOARD / repo, and only escalates to a human via Discord when it is not.

Non-goals: distributed execution across machines, long-lived background supervision without a human session open, replacing `/ccx:loop` itself.

---

## 2. Three documents at a glance

Three distinct files play distinct roles. Keeping their purposes separate avoids the conceptual drift that happens when one word (e.g. "handoff") ends up meaning two different things.

| File | Purpose | Who writes | Who reads |
|---|---|---|---|
| `BOARD.md` (repo root) | Task queue + project direction. One row per task with `status`, `scope`, `depends_on`. Intentionally terse — queue entry, not spec. | supervisor (mostly); humans edit direction & add tasks | supervisor + humans |
| `.ccx/tasks/T-<id>.md` | Per-task brief — full spec for a single task. Fixed H2 schema (see §6). | supervisor | worker (treats as complete spec) |
| `.handoff.md` (existing — do not repurpose) | Session-to-session state: what the last `/ccx:loop` run did, unresolved findings, current state. Auto-maintained by `/ccx:loop` Phase 3. | `/ccx:loop` | next session (human or ccx) |

**Storage** is markdown + YAML frontmatter: humans edit comfortably, Git diffs render cleanly, GitHub renders. **Transfer** (supervisor → worker at dispatch time) wraps the brief in XML tags (see §7) — following Anthropic's prompt-construction guidance that XML is for unambiguous delimiters inside prompts, not for on-disk file formats.

---

## 3. Architecture

```
                    ┌─────────────────────────────────┐
                    │   supervisor session            │
                    │   (/ccx:supervisor)             │
                    │   - reads BOARD.md              │
                    │   - writes .ccx/tasks/T-*.md    │
                    │   - dispatches workers          │
                    │   - merges approved work        │
                    └──────────┬──────────────────────┘
                               │ Bash(run_in_background)
                               │ claude -p "/ccx:loop ...
                               │   <task_brief>...</task_brief>"
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

## 4. Spawn mechanism — `claude -p` as background subprocess

The supervisor launches each worker via `Bash(run_in_background=true)`:

```bash
claude -p \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --output-format stream-json \
  "$DISPATCH_PROMPT" \
  > .ccx/workers/<TASK_ID>.log 2>&1
```

`$DISPATCH_PROMPT` is assembled per §7.

Rationale:

- **True process isolation.** Each worker is its own Claude Code session with its own skills, hooks, permission state. A worker that hangs or crashes does not affect the supervisor.
- **Native skill invocation.** Workers execute `/ccx:loop` exactly as a human would run it — no need to inline the body into an Agent prompt.
- **Existing tooling reused.** `/ccx:loop --worktree --commit --chat` already handles isolation, auto-commit gating, and Discord bridging. The supervisor adds orchestration, nothing else.

### 4.1 Flags — why each one

- `--permission-mode bypassPermissions` — `/ccx:loop` issues many `Bash(git …)` / `Bash(codex …)` calls. In `-p` mode a TTY-based prompt cannot resolve, so a stricter mode would block the worker. Blast radius is bounded by `--worktree` (sibling directory on an isolated branch); the worker cannot touch main.
- `--no-session-persistence` — avoids polluting `/resume` history with ephemeral worker runs.
- `--output-format stream-json` — lets the supervisor optionally parse worker events in real time (tool calls, phase transitions) instead of only reading end-of-run logs.

### 4.2 Worker-to-supervisor flags — `/ccx:loop`

Workers are always dispatched with:

- `--worktree=<TASK_ID>` — guarantees per-task working-tree isolation so Codex review diffs do not cross-contaminate.
- `--commit` — auto-commit when the Phase 4 gate passes (approve + zero unresolved + tests pass/na + no stuck). Without this, the commit prompt would fall back to `AskUserQuestion` in `-p` mode and hang.
- `--chat` — routes all `chat_*` calls through the broker so the supervisor can intercept.

### 4.3 Completion detection

Three independent signals. The supervisor treats a worker as terminated when any one fires, then cross-checks the other two for the actual status:

1. **Background shell exit.** `Bash(run_in_background=true)` returns a shell id; the supervisor polls its status. Non-zero exit = worker crashed, missing git state.
2. **`chat_close` status.** `/ccx:loop` calls `chat_close({status: ...})` in a finally block with one of `approved | filtered-clean | stuck | budget-exhausted | aborted | error`. The broker records this per session. Supervisor queries `mcp__ccx-chat__*` (or reads broker state) for the final status.
3. **Branch HEAD presence.** The worktree branch `ccx/<TASK_ID>` exists with a new commit authored by Claude. If `chat_close` says `approved` but no commit exists, the worker lied or crashed after approval; supervisor treats this as error.

---

## 5. `BOARD.md` schema

`BOARD.md` lives at the repo root. It is both human-editable and supervisor-parseable. Each task is a YAML block inside a fenced code block under a `## Tasks` section so the surrounding markdown (rationale, direction, notes) stays free-form.

```markdown
## Direction

Free-form prose describing current project priorities, constraints,
upcoming milestones. The supervisor reads this when deciding task
order and when answering worker questions autonomously.

## Tasks

```yaml
- id: T-12
  title: "Add supervisor adapter to ccx-chat broker"
  scope:
    include:
      - plugins/ccx/mcp/ccx-chat/adapters/*.mjs
      - plugins/ccx/mcp/ccx-chat/broker.mjs
    exclude: []
  status: pending            # pending | assigned | review | merged | blocked
  priority: normal           # low | normal | high
  depends_on: []             # other task ids that must be merged first
  brief: .ccx/tasks/T-12.md  # path to the per-task brief (§6)
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

- `id` is the **stable key**; supervisor never renames. Used as `--worktree=<id>` name, branch suffix, brief-file name, and log-file name.
- `scope.include` is a list of globs. **Two tasks whose scope globs do not overlap can run in parallel**; overlapping scopes are serialized. This is how the supervisor prevents concurrent worktrees from producing conflicting merges.
- `status` transitions: `pending → assigned → (review) → merged`. `blocked` is terminal and needs human action.
- `exit_status` mirrors `chat_close`'s status verb so merging logic can key off a single field.
- BOARD is the **queue card**; fine-grained decisions and autonomous-answer lookup tables live in the brief (§6), not here.

Supervisor writes updates to `BOARD.md` itself — edits are atomic (read → modify → write) and committed on the integration branch after each batch of merges.

---

## 6. Task brief files (`.ccx/tasks/T-<id>.md`)

The brief file is the complete spec for a single task. It is the worker's read-once source of truth during Phase 1 of `/ccx:loop`. BOARD rows are queue entries; the brief carries the depth.

### 6.1 Location and lifecycle

- Path: `.ccx/tasks/T-<id>.md` — same `T-<id>` that appears in BOARD.
- Created by the supervisor **before** dispatch. The create-brief + dispatch pair is atomic: if brief creation fails, dispatch does not happen.
- Committed as part of the supervisor's dispatch commit on the integration branch, so the brief is version-controlled and auditable.
- Revised in place on re-dispatch after `stuck` or `blocked` exit; git history preserves the revision.

### 6.2 Fixed schema — 6 H2 sections, in this order

The schema is a **contract**. Supervisors emit exactly these six sections in this order. Workers expect this order. Empty sections are allowed (e.g. `## Out of scope\n\n_None._`) but the heading must be present — that keeps parsing schema-driven instead of heuristic.

```markdown
---
id: T-12
title: "Add supervisor adapter to ccx-chat broker"
scope:
  include:
    - plugins/ccx/mcp/ccx-chat/adapters/*.mjs
    - plugins/ccx/mcp/ccx-chat/broker.mjs
  exclude: []
depends_on: []
---

# Add supervisor adapter to ccx-chat broker

## Goal
One short paragraph: what outcome this task achieves and why it matters.

## Acceptance
Checkbox list of concrete, testable completion conditions.
- [ ] ...
- [ ] ...

## Context
Pointers the worker needs: related files, prior decisions, similar
implementations to mirror, constraints the BOARD direction doesn't
already cover.

## Out of scope
Explicit list of things NOT to change. Keeps diffs focused and
prevents scope creep when the task description is read loosely.

## Test plan
How the worker verifies its own work before Codex review. If a test
file already exists, point at it; otherwise specify what to add.

## Decisions
Key–answer table the supervisor pre-populates with foreseeable
ambiguities. When a worker's chat_ask semantically matches one of
these, the supervisor's supervisor-adapter answers autonomously
without escalating to the human.
- q: "X vs Y library choice?"
  a: "Use Y. Reason: ..."
```

### 6.3 Why a separate file, not inline in BOARD

- BOARD needs to stay scannable — one screen shows the whole queue.
- Briefs are long-tail: some tasks need 1 line of spec, some need 200. Embedding them in BOARD would destroy its scan-ability.
- Briefs are per-task; BOARD is per-project. Different edit frequencies, different audit surfaces.
- Brief files are discoverable by path (`.ccx/tasks/T-12.md`) without having to grep through BOARD.

---

## 7. Dispatch prompt shape

The dispatch prompt is the single CLI argument the supervisor passes to `claude -p`. Because a bare one-liner cannot carry enough context, the supervisor embeds the brief and project direction into the prompt using XML tags. This follows Anthropic's prompt-construction guidance: XML tags give Claude unambiguous delimiters inside prompts. The tags are a **prompt concern**, not an on-disk format.

### 7.1 Prompt template

```
/ccx:loop --worktree=T-12 --commit --chat

<task_brief path=".ccx/tasks/T-12.md" id="T-12">
{{entire contents of .ccx/tasks/T-12.md}}
</task_brief>

<project_direction source="BOARD.md">
{{Direction section from BOARD.md, verbatim}}
</project_direction>

<instructions>
Read <task_brief> as your complete spec. Implement exactly what its
Acceptance section requires, respect Out of scope, and verify with
Test plan before handing off to Codex review.

When something is ambiguous and not covered by the Decisions section
of the brief, call chat_ask with the specific question. The
supervisor will answer from the brief / BOARD / repo if possible,
or escalate to the human via Discord.

Do not edit files outside <task_brief>.scope.include.
</instructions>
```

### 7.2 Why embed the full brief instead of "read the file"

Alternative: `claude -p "/ccx:loop ... Read .ccx/tasks/T-12.md and execute it."` That works, but embedding the brief directly has two advantages:

1. **Deterministic context.** The worker sees the brief as part of its first user message, guaranteed, before any tool use. Reading the file is an extra tool call the worker could forget, delay, or misinterpret the path of.
2. **Audit surface.** The dispatch log (`.ccx/workers/T-12.log`) captures the exact brief-as-dispatched. If the brief is later revised, the log still shows what the worker was told at dispatch time.

Tradeoff: prompt size grows with brief size. For briefs over ~4KB, switch to the "read the file" variant — the brief is still committed, so audit is preserved via git. The supervisor can measure brief length and choose automatically.

### 7.3 Why XML tags, not more markdown

Markdown inside a prompt has ambiguous delimiters — an `##` inside the brief body looks the same as an `##` inside the supervisor's instructions. XML tags (`<task_brief>`, `<project_direction>`, `<instructions>`) give Claude unambiguous section boundaries and carry attribute metadata (`path`, `id`, `source`) without mixing into the content.

---

## 8. Escalation flow — worker → supervisor → human

### 8.1 Broker supervisor adapter (path A, chosen)

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
3. Supervisor receives the event, consults the task brief's `## Decisions` section + BOARD direction + repo state, decides:
   - **autonomous answer available** → adapter returns `{ reply, source: "supervisor-auto" }`.
   - **escalate** → supervisor calls `chat_ask` on the **Discord adapter** with the question rewrapped (task id, worker branch, original question, brief excerpt). Human replies. Supervisor relays the reply back through the socket to the original worker's pending `chat_ask`.
   - **defer/refuse** → adapter returns `{ reply: null, source: "closed" }` and the worker follows its existing `chat_ask` failure path (falls back to `AskUserQuestion`, which fails in `-p`, and the loop aborts cleanly).
4. `chat_send` (one-way status messages from workers) gets two behaviors by flag:
   - Per-worker chatter: forwarded to a **single supervisor-scoped thread** in Discord (one thread per task id), not to the top-level channel.
   - Decisions / escalations: go to the main channel the human watches.

### 8.2 Why keep the broker

The existing broker already handles Unix-socket IPC, session registry, ask/reply correlation, and timeouts. The supervisor adapter is a ~200-line file that forwards events; broker core is untouched. Workers remain unchanged — they keep calling `chat_ask` / `chat_send` regardless of backend.

### 8.3 What the supervisor session runs

The supervisor slash command (`/ccx:supervisor`) itself must:

- Start a local listener on `/tmp/ccx-supervisor.sock` (see below for two options).
- Spawn N worker background processes.
- Poll for completion signals (shell exit, chat_close, branch HEAD).
- Handle incoming `chat_ask` forwards: read question, consult the brief + BOARD, reply or escalate.
- Drive the integration branch: on approved worker completion → `git merge --no-ff ccx/<id>` into the integration branch → update `BOARD.md` → commit.

Socket listener implementation — two viable options:

- **(a) Inline Node from Bash.** Spawn a Node child via `node -e '…'` once at command start; it reads socket lines and appends them to a file the supervisor tail-reads. Simple, no long-lived state, dies with the supervisor session.
- **(b) Broker-bundled.** Add a `supervisor-pending.log` mode to the existing broker that appends forwarded questions. Supervisor just reads that file. No new process at all.

(b) is preferred; it reuses the broker's lifecycle management.

---

## 9. Parallel slot management

Supervisor loop (pseudocode):

```
slots = N              # --parallel N, default 3
running = {}           # task_id -> { shell_id, worktree, started_at }

while pending_tasks_exist() or running:
    # 1. Fill slots.
    while len(running) < slots and (task := pick_next_ready_task()):
        write_brief(task)                 # .ccx/tasks/T-<id>.md
        dispatch(task)                    # writes .log, updates BOARD.md
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
- `stuck` / `budget-exhausted` → mark `status: blocked`, post the worker's last cycle summary to Discord, include the Codex findings that tripped stuck detection, human decides (possibly revise the brief's Decisions section and re-dispatch).
- `aborted` / `error` → mark `status: blocked` with the log path.

---

## 10. Merge policy

- **Integration branch** defaults to `main` but `--integration=<branch>` can redirect. Supervisor never force-pushes. Merges are `--no-ff` so each task shows up as one merge commit.
- **Worktree cleanup** is deferred to the human. Supervisor reports the `git worktree remove` commands after merge, following `/ccx:loop`'s existing contract (which also leaves worktrees).
- **Post-merge `BOARD.md` update** is a single commit per batch of merges, not per individual merge, to avoid N+1 commits cluttering history. Commit subject: `supervisor: merge T-12, T-15, T-19 — update board`.

---

## 11. Permission handling

Supervisor runs in interactive mode (the human is present). Workers run in `-p` with `--permission-mode bypassPermissions`. This is acceptable because:

- Workers only operate inside their worktree (Codex review, Edit/Write, build, test, commit).
- The sibling worktree path is outside the main repo's working tree — a rogue worker cannot touch uncommitted work in the main checkout.
- Workers never call `git push` unless the task description explicitly requests it; `/ccx:loop` Phase 4 does not push by default.
- Network / system-level operations are still constrained by the user's shell environment.

A stricter alternative — `--permission-mode acceptEdits` plus per-repo `.claude/settings.json` allowlist of `Bash(git *) Bash(node *) Bash(npm *) ...` — can replace `bypassPermissions` once the allowlist is tuned. Starting bypass makes the MVP shippable; tightening is a follow-up.

---

## 12. `/ccx:supervisor` command shape

```
/ccx:supervisor [--parallel N] [--integration BRANCH] [--max-tasks M] [--dry-run]

--parallel N        max concurrent workers (default 3, clamp 1..10)
--integration B     branch to merge into (default main)
--max-tasks M       stop after M merges even if tasks remain (default unlimited)
--dry-run           parse BOARD.md, print dispatch plan, do nothing
```

Phases inside `/ccx:supervisor`:

- **P0 pre-check**: clean tree on integration branch, `BOARD.md` parses, broker `backend: supervisor`, `.ccx/tasks/` writable.
- **P1 plan**: list ready tasks, print the dispatch order (which tasks parallel vs serialized due to scope overlap or deps), ask confirm (unless `--dry-run`).
- **P2 run**: the scheduling loop, until done or `--max-tasks` reached.
- **P3 report**: final summary (merged / blocked / skipped), pointer to `.ccx/workers/*.log` and `.ccx/tasks/*.md` for each worker.

---

## 13. MVP milestones

1. **M1 — dispatch only.** `/ccx:supervisor` reads `BOARD.md`, generates `.ccx/tasks/T-<id>.md` from a template, spawns workers with `claude -p … /ccx:loop --worktree --commit --chat` using the XML-wrapped dispatch prompt from §7, polls shell exit, marks status `merged` on `approved` exit (naive merge, no conflict handling). No escalation, no socket, no autonomous answering. Human handles any `chat_ask` directly via the existing Discord path.
2. **M2 — supervisor adapter + escalation.** Add `adapters/supervisor.mjs`, broker config gains `backend: "supervisor"`, `/ccx:supervisor` reads forwarded `chat_ask` events and escalates to Discord. Autonomous answering still stubbed — everything escalates.
3. **M3 — autonomous answering.** Supervisor consults the brief's `## Decisions`, BOARD direction, and prior merge commit messages to answer without escalating. Log every autonomous answer so the human can audit.
4. **M4 — scope conflict detection.** Scope glob overlap check gates parallelism. Pre-merge conflict dry-run (`git merge --no-commit --no-ff <branch>`, then `git merge --abort`) before committing the merge.
5. **M5 — stuck recovery.** On `stuck` exit, supervisor can optionally revise the brief's Decisions section (from the stuck-finding content) and re-dispatch, or escalate if the revision would require human judgement.

M1 and M2 are enough to be useful. M3–M5 are quality-of-life.

---

## 14. Open questions

- **Broker singleton vs supervisor scope.** The broker is global (one per host). Can two simultaneous supervisor sessions coexist? Probably not on MVP — require one supervisor at a time, enforce with a lock file.
- **What if the human closes the supervisor session mid-run?** Workers keep running (they're independent processes). On resume (`/ccx:supervisor --resume`), re-read `BOARD.md` and reconcile by checking branch HEADs, `.ccx/workers/*.log` tails, and `chat_close` records. Stretch goal.
- **Long-running workers vs budget.** A single worker running `/ccx:forever` inside `-p` has no natural budget cap and can burn tokens indefinitely. Recommendation: supervisor always launches `/ccx:loop --loops N` (not `forever`), with an explicit N, so each worker is bounded.
- **Brief size cap.** §7.2 suggests switching from inline embed to "read the file" for briefs over ~4KB. The threshold is a guess; measure in practice.
