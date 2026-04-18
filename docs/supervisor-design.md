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
  attempts: 0                # supervisor-managed (M5); starts at 1 on first dispatch, increments on stuck re-dispatch
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

- **Integration branch** defaults to `main` but `--integration=<branch>` can redirect. Supervisor never force-pushes.
- **Merge mechanism**: `git merge --squash` (pre-M6 §15.1; replaces an earlier `--no-ff` design). Each task lands as exactly one supervisor-authored commit on the integration branch with subject `T-<id>: <title>`. Rationale: `/ccx:loop` Phase 4 already squashes its review-fix cycles into a single commit, so a `--no-ff` merge would only add a tree-empty graph node — pure noise. Squash gives the same audit surface (one commit per task, identifiable by its `T-<id>:` subject) without the extra commit. Conflict detection still happens before commit creation: the supervisor stages the squash, inspects `git ls-files -u`, and either commits (clean) or rolls back via `git restore --staged --worktree .` (conflict). The rollback is guarded by a pre-merge `git status --porcelain` cleanliness assert so the wholesale restore can never destroy unrelated uncommitted changes.
- **Worktree cleanup** is deferred to the human. Supervisor reports the `git worktree remove` commands after merge, following `/ccx:loop`'s existing contract (which also leaves worktrees).
- **Post-merge `BOARD.md` update** is a single commit per batch of merges, not per individual merge, to avoid N+1 commits cluttering history. Commit subject: `supervisor: update board — merged T-12, T-15, T-19, blocked T-9`.

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

1. **M1 — dispatch only** (shipped 2026-04-17, commit `873dc5c`). `/ccx:supervisor` reads `BOARD.md`, generates `.ccx/tasks/T-<id>.md` from a template, spawns workers with `claude -p … /ccx:loop --worktree --commit --chat` using the XML-wrapped dispatch prompt from §7, polls shell exit, marks status `merged` on `approved` exit (naive merge, no conflict handling). No escalation, no socket, no autonomous answering. Human handles any `chat_ask` directly via the existing Discord path.
2. **M2 — supervisor adapter + escalation** (shipped 2026-04-17, commit `a6ea2fe`). `adapters/supervisor.mjs`, broker config `backend: "supervisor"`, and `chat_supervisor_{poll,reply,escalate,close}` MCP tools land. Workers' `chat_ask` calls queue in the broker and auto-escalate to Discord after `supervisor.autoEscalateAfterSec` seconds (default 60); the supervisor-side polling stub is present but everything escalates.
3. **M3 — autonomous answering** (shipped 2026-04-17, commit `7e4b8bc`). Supervisor consults the brief's `## Decisions`, BOARD direction, and prior worker commits on the integration branch to answer without escalating. Every decision lands in `.ccx/supervisor-audit/<RUN_ID>.jsonl` for audit.
4. **M4 — scope conflict detection** (shipped 2026-04-17, commit `573e39c`). Scope glob overlap check gates parallelism via `git ls-files -- <pathspecs>` intersection with literal and prefix fallbacks. Pre-merge conflict dry-run (`git merge --no-commit --no-ff <branch>` then `git commit --no-edit` or `git merge --abort`) separates conflict detection from commit creation. New blocked reasons: `merge-aborted`, `merge-commit-failed` (the latter sets `STOP_DISPATCHING` and drains existing peers via new exit condition 3).
5. **M5 — stuck recovery** (shipped 2026-04-17). Broker records every `chat_close` status in an in-memory ring buffer (`chat_supervisor_recent_closures` MCP tool, capped at 256 entries). Supervisor Step B peels stuck exits out of the generic `no-commit` bucket by querying the buffer. First stuck per task triggers a single `AskUserQuestion` (three-way: re-dispatch with guidance via "Other", re-dispatch unchanged, abort); on guidance the supervisor appends a `## Decisions` entry, commits the revised brief, cleans the prior worktree+branch, and re-spawns. `STUCK_REDISPATCH_CAP = 2` hard-caps at one re-dispatch; a second stuck blocks as `stuck-exhausted`. New blocked reasons: `stuck-exhausted`, `stuck-aborted`, `stuck-recovery-failed`, `stuck-cleanup-failed`. BOARD rows gain an `attempts` field (optional, normalized to 0).
6. **Pre-M6 hotfixes** (shipped 2026-04-18; design in §15). Four runtime hotfixes surfaced by the first e2e run land before M6: §15.1 `--squash` merge policy (replaces `--no-ff`, one supervisor-authored commit per task with `T-<id>: <title>` subject); §15.2 Step C adaptive `BashOutput`-watch + 2s-sleep + 30s-cap polling primitive (replaces fixed `sleep 3`, robust to LLM deviation and harness sleep guards); §15.3 supervisor Discord presence via new `--chat` flag (lifecycle `chat_send` for run start / dispatch / merge / block / stuck / end); §15.4 repo basename prefix on every ccx-chat message body (disambiguates concurrent ccx sessions across repos).
7. **M6 — planning phase** (proposed 2026-04-18, design in §14). Free-form-input → `BOARD.md` draft, mandatory review gate before dispatch. Closes the last onboarding cliff: M1–M5 assume `BOARD.md` already exists, but today the schema is plugin-internal knowledge and the plugin ships no scaffolding. M6 makes planning the entry path so humans never hand-author YAML.

M1 and M2 are enough to be useful. M3–M5 are runtime quality-of-life. The pre-M6 hotfixes (§15) tighten merge history, fix a Step C deadlock failure mode, and give the supervisor its own Discord voice. M6 is the entry-path fix and is the last blocker for non-author adoption.

---

## 14. M6 — Planning phase (BOARD.md scaffolding from free-form input)

Status: proposed (2026-04-18). Driven by the observation that after M1–M5 ship, the **only remaining human-authored artifact** is `BOARD.md`, and its schema (YAML-in-fenced-block, scope globs, depends_on, attempts) is plugin-internal knowledge. Forcing users to learn the schema before they can use the supervisor is the last onboarding cliff.

### 14.1 Problem

- `BOARD.md` schema lives in §5 of this design doc and inside `plugins/ccx/commands/supervisor.md` §P1. The plugin ships no `BOARD.md.example`, no `--init` scaffolder, no error-message pointer.
- Even with a template, the human shouldn't *have to* think in YAML rows (`scope.include`, `depends_on`, `attempts`, `worker_pid`). They should be able to describe intent in the format they already prefer — a prompt, a PRD, a ticket export, a CLAUDE.md-style note — and get a reviewable draft back.
- Most of those fields (`attempts`, `worker_pid`, `started_at`, `exit_status`, `worktree`, `branch`) are supervisor-managed anyway. Humans should touch `title`, `scope.include`, `depends_on`, `notes` at most.

### 14.2 Direction (not yet chosen)

A **mandatory planning step** before any dispatch ever happens. The planning step is LLM-driven: it reads a prompt or a user-supplied document, explores the repo for grounding, emits a `BOARD.md` draft, and blocks on human review before the supervisor can dispatch anything.

Two shapes are plausible — pick one in M6 design finalisation:

- **Shape A — separate `/ccx:plan` command.** `/ccx:plan <prompt|--from path>` writes `BOARD.md` (or appends rows if one exists), commits it as `supervisor: plan draft`, prints the diff, stops. Human reviews/edits, then runs `/ccx:supervisor` as today. Clean contract: planning and orchestration stay separate, each LLM-driven step has its own command surface.
- **Shape B — integrated into `/ccx:supervisor`.** On invocation, if `BOARD.md` is missing or all rows are `status: draft`, supervisor enters plan mode: prompts for input, writes draft, calls `AskUserQuestion` for Proceed/Edit/Abort, then continues to dispatch. One command, bigger surface. Conflates the LLM-creativity phase with the deterministic-scheduler phase.

Both shapes require the same sub-decisions (§14.3). Shape A is the less-entangled option and preserves the supervisor's deterministic-parser property; Shape B is the shorter UX path but violates the separation of concerns that M4's merge dry-run and M5's AskUserQuestion already blurred.

### 14.3 Sub-decisions for M6

1. **Input forms accepted.** At minimum:
   - Prompt string: `/ccx:plan "add OAuth2 login flow"` — free-form, LLM does decomposition.
   - Document reference: `/ccx:plan --from docs/prd-oauth.md` — LLM reads the file the user already wrote in the user's preferred format (PRD, design note, Linear export, whatever).
   Both must coexist. Document reference is the more important one because it respects the user's existing workflow — many teams already write specs, and the plugin shouldn't force a new format.

2. **Scope grounding.** LLM must derive `scope.include` from *actual repo files*, not guesses. Plan step needs tool access to `Glob`, `Grep`, `Read` against the repo at run time. Ungrounded scopes produce M4 gate misfires at dispatch time — worse than no plan.

3. **Review gate shape.**
   - Option 3a: draft committed as `BOARD.md`, human reviews via `git diff`, edits, commits amendments, re-runs supervisor.
   - Option 3b: draft written but NOT committed; supervisor/plan command calls `AskUserQuestion` with Proceed/Edit/Abort; on Proceed commits, on Edit opens editor (not trivial in `-p` mode).
   - Option 3c: introduce `status: draft` alongside `pending`. Plan writes rows as `draft`; supervisor ignores `draft` at dispatch time; human flips `draft → pending` once satisfied. Keeps BOARD single-source-of-truth, no out-of-band state. **Recommended.**

4. **Mandatory vs optional planning.** User preference as of 2026-04-18: mandatory. Meaning: BOARD.md cannot be authored purely by hand *without* going through `/ccx:plan` at least once. Enforcement mechanism TBD — possibly a hash/provenance field in BOARD front-matter, possibly a soft convention enforced via supervisor pre-check warning.

5. **Task-ID allocation.** `T-<n>` numeric suffix. Plan appends starting from `max(existing) + 1`. Never reuses IDs even if prior tasks were `blocked` and removed, because brief filenames and branch names are keyed off ID.

6. **Re-planning an existing BOARD.md.** When the human wants to add tasks to a BOARD that already has some — `/ccx:plan --append <prompt>` vs `/ccx:plan --from new-prd.md`. Plan should never silently modify existing `pending`/`assigned`/`merged` rows, only append.

7. **Relation to `--init`.** Shipping a zero-input `/ccx:supervisor --init` alongside M6 is still worthwhile for users who want to start by hand-editing a skeleton. `--init` writes an empty-task skeleton with the Direction placeholder; `/ccx:plan` fills a draft from actual input. Both can coexist.

### 14.4 Why this belongs as M6, not a nice-to-have

Every prior milestone (M1–M5) assumed BOARD.md already exists. At this point the supervisor is feature-complete for its intended runtime behaviour — but the *entry path* is still a cliff: read a 700-line design doc, hand-write YAML, then invoke. That's the gap M6 closes. It's the difference between a working prototype (today) and something the author of this repo's next colleague can pick up on their own.

---

## 15. Pre-M6 hotfixes and follow-ups (from e2e 2026-04-18)

Items surfaced during the first end-to-end run against `/tmp/ccx-e2e`. Each scoped tightly so they ship independently or batched with M6. Do NOT pick these up until the e2e sandbox is cleaned or rebuilt — the current `/tmp/ccx-e2e/` has a half-merged dispatch that should be wiped before re-testing.

### 15.1 `--squash` merge policy (replaces `--no-ff`) — shipped 2026-04-18

**Why:** §10 picked `--no-ff` on the assumption workers land multi-commit branches worth preserving as a group. In practice `/ccx:loop`'s Phase 4 squashes cycles into one final commit, so a task branch has exactly one commit — and `--no-ff` adds a parent-only merge commit that carries **zero new tree changes**, just a graph node. With `--squash`, one task = one supervisor-authored commit on integration: cleaner history with the same audit surface.

**Touch points:**
- `supervisor.md` Step B3 (pre-merge dry-run) — replace `git merge --no-commit --no-ff` algorithm with `git merge --squash` + conflict probe via `git ls-files -u`. Rollback is NOT `git merge --abort` (doesn't apply to squash) — use `git restore --staged --worktree .`, guarded by a pre-merge `git status --porcelain` cleanliness assert so the rollback never blows away unexpected uncommitted state.
- `supervisor.md` Step B real merge commit — subject = `T-<id>: <title>`, author = supervisor. Keeps task identity in the first line of the commit, which is what `--no-ff`'s implicit merge commit was really for.
- `supervisor.md` §P2.4 — `merge-aborted` / `merge-commit-failed` state names can stay; semantics still apply with the new algorithm.
- design doc §10 — update policy + rationale.
- memory M4 note — `--no-ff --no-commit` → `--squash`.

### 15.2 Step C sleep robustness — shipped 2026-04-18 (option B)

**Why:** Spec says `sleep 3`. First e2e run had supervisor-Claude run `sleep 60` instead (LLM deviated from the literal instruction — model inferred "60s is more reasonable when waiting on LLM workers"). Claude Code 2.1.x blocks long standalone leading sleeps, so the scheduling loop hung at Step C and workers' completions were never drained.

**Options:**
- **A (minimal):** strengthen wording. "MUST be exactly `sleep 3`. Never `sleep 30`, never `sleep 60`. The harness blocks long leading sleeps; anything over a few seconds stalls the loop." Fragile — relies on future supervisor-Claude reading and obeying literally.
- **B (robust):** replace sleep with a polling primitive that works regardless of exact duration — `until any_worker_has_new_output_or_timeout; do sleep 2; done`, capped at 30s. `any_worker_has_new_output` = iterate `RUNNING` and call `BashOutput` on each `shell_id`; break if any returns new lines since the last check. This also fixes the orthogonal problem where supervisor polls on a fixed cadence even when nothing has happened.

Recommend B — it's the same amount of prose to document, more robust to LLM deviation, and measurably reduces wake-ups on quiet iterations.

### 15.3 Supervisor Discord presence — shipped 2026-04-18 (`--chat` flag)

**Why:** Workers post to Discord via their `chat_send` calls, so the user sees worker chatter. Supervisor itself has no Discord route, so from Discord you cannot tell "a supervisor run started in repo X", "it dispatched T-1 and T-2", "T-1 merged / T-2 blocked", or "the run ended with 3 merged". That's the orchestration timeline the user actually wants to watch, and it's entirely missing.

**Proposed lifecycle messages** (fire-and-forget `chat_send`, not `chat_ask`):
- **Start:** `[<repo>] supervisor run <RUN_ID> — N pending, parallel=2, worker-loops=3, integration=main`
- **Dispatch:** `[<repo>] supervisor → T-<id> "<title>" dispatched to worker <sessionId>` — making the worker↔supervisor linkage explicit so later `T-<id>` chat messages from that worker are recognisable as the supervisor's delegate.
- **Merge:** `[<repo>] supervisor ← T-<id> merged (<short_sha>)`
- **Block:** `[<repo>] supervisor ← T-<id> blocked: <exit_status>`
- **Stuck-recovery prompt:** `[<repo>] supervisor ← T-<id> stuck — human guidance requested` (AskUserQuestion already routes to Discord via supervisor-mode fallback; the lead-in message makes the trigger source obvious).
- **End:** `[<repo>] supervisor run <RUN_ID> complete — merged=N, blocked=M, stranded=K, duration=t`

**Mechanism:** Supervisor registers its own ccx-chat session at P0 with a label like `[supervisor] <repo_basename>`. Uses `chat_send` only (no asks, nothing queues). Gated behind a `--chat` flag on `/ccx:supervisor` to mirror worker semantics. When `backend: "supervisor"`, the supervisor's own sends fall through to the Discord fallback — already plumbed in `adapters/supervisor.mjs`.

### 15.4 Repo-name prefix on all ccx-chat messages — shipped 2026-04-18

**Why:** User runs many concurrent ccx sessions across different repos (`ccx-loop`, `gold-digger-*`, etc.). Current Discord messages carry session label + branch but not the repo. Prefix disambiguates.

**Privacy concern raised 2026-04-18:** "괜찮을까" — broadcasting repo names to a channel that might be shared. Recommend **repo basename** (e.g. `ccx-loop`, not `/home/will/Repositories/ccx-loop`) so the prefix stays short and never leaks absolute paths. If basename alone isn't enough (two repos with the same name), fall back to `<parent>/<basename>`. Never log the absolute path.

**Touch points:**
- `plugins/ccx/mcp/ccx-chat/adapters/discord.mjs` — compute `repoBasename = basename(session.cwd)` at session-registration time, prepend to every message body in the format helpers.
- Per-session color tag stays; repo prefix is on the body, color is on the author.

Non-goal: re-rendering the branch as a prefix (already in session label, would double-render).

---

## 16. Open questions

- **Broker singleton vs supervisor scope.** The broker is global (one per host). Can two simultaneous supervisor sessions coexist? Probably not on MVP — require one supervisor at a time, enforce with a lock file.
- **What if the human closes the supervisor session mid-run?** Workers keep running (they're independent processes). On resume (`/ccx:supervisor --resume`), re-read `BOARD.md` and reconcile by checking branch HEADs, `.ccx/workers/*.log` tails, and `chat_close` records. Stretch goal.
- **Long-running workers vs budget.** A single worker running `/ccx:forever` inside `-p` has no natural budget cap and can burn tokens indefinitely. Recommendation: supervisor always launches `/ccx:loop --loops N` (not `forever`), with an explicit N, so each worker is bounded.
- **Brief size cap.** §7.2 suggests switching from inline embed to "read the file" for briefs over ~4KB. The threshold is a guess; measure in practice.
