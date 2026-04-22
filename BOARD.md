## Direction

Active milestone: **M7 — model tier escalation in supervisor**. When a worker exits without approval the supervisor re-dispatches at a higher model tier so "if the loop drags on, escalate to a better model" is automatic. Motivation: default runs were burning Opus on trivial tasks (no per-task control) and Claude effort was implicit; M7 surfaces both axes as explicit supervisor knobs.

Design decisions locked in this milestone (referenced by T-1 notes and woven into `docs/supervisor-design.md` §M7 by T-1):

- 5-rung ladder: `haiku(medium) → sonnet(medium) → opus(high) → opus(xhigh) → opus(max)`.
- New supervisor flags: `--max-attempts N` (default 4), `--worker-loops N` (default 3, forwarded as `/ccx:loop --loops`), `--start-tier <haiku|sonnet|opus|opus-xhigh|opus-max>` (default `sonnet`).
- Escalation rules: `stuck` exit bumps tier; `cycle-cap` exit retries same tier; budget is `--max-attempts`.
- End-of-ladder handling: at `opus-max`, `stuck` → human escalation, `cycle-cap` → same-tier retry until budget exhausted.
- BOARD schema and `/ccx:plan` unchanged; only supervisor + docs are touched.
- `--start-effort` override and per-task model profile are **out of scope** for M7.

## Tasks

```yaml
- id: T-1
  title: "M7 design: document tier escalation in supervisor-design.md"
  scope:
    include:
      - docs/supervisor-design.md
    exclude: []
  status: assigned
  priority: normal
  depends_on: []
  brief: .ccx/tasks/T-1.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-1"
  branch: "ccx/T-1"
  worker_pid: null
  started_at: "2026-04-22T14:45:28Z"
  finished_at: null
  exit_status: null
  notes: |
    Add a new "## 15. M7 — Model tier escalation" section to
    docs/supervisor-design.md after the existing M6 section (§14),
    matching the SSOT style of M1–M6. Source of truth for this
    milestone — T-2 implements against whatever T-1 lands.

    Section MUST cover:

    1. Motivation — before M7, workers always ran on whatever model
       the supervisor session happened to use; no per-task or per-retry
       control. M7 adds tier escalation driven by the worker's exit
       signal.

    2. The 5-rung ladder (fixed order, no config):
       - haiku   + effort medium
       - sonnet  + effort medium
       - opus    + effort high
       - opus    + effort xhigh
       - opus    + effort max
       Implemented by passing `--model <alias>` and `--effort <level>`
       to each `claude -p` worker spawn. Alias (not pinned model ID)
       so model bumps don't require design-doc edits.

    3. Three new supervisor flags, with defaults and semantics:
       - `--max-attempts N` (default 4) — max worker re-dispatches per
         task. Default 4 covers full ladder from the default start
         tier (sonnet → opus → opus-xhigh → opus-max). Attempts
         count is persisted as BOARD's existing `attempts` field;
         no new BOARD fields.
       - `--worker-loops N` (default 3) — forwarded to each worker
         as `/ccx:loop --loops <N>`. This is the per-worker cycle
         cap, an independent axis from --max-attempts.
       - `--start-tier <haiku|sonnet|opus|opus-xhigh|opus-max>`
         (default `sonnet`). First attempt runs at this tier; ladder
         starts here. Tiers below the start point are unreachable
         for that task (effective ladder length shrinks).

    4. Escalation rules keyed on worker exit signal:
       - `stuck` (same finding 3 consecutive cycles, existing
         `/ccx:loop` behavior) → `attempts++`, **tier bumps +1**,
         re-dispatch.
       - `cycle-cap` (loops exhausted, stuck NOT detected — findings
         rotated across cycles) → `attempts++`, **same tier**,
         re-dispatch.
       - `approved` → task complete, merge (existing M1 path).
       - Stuck-vs-cap ambiguity (e.g., with --worker-loops 3 where
         all 3 cycles hit the same finding): **stuck takes precedence**
         so the tier bumps.
       - End-of-ladder (at opus-max): `stuck` → human escalation
         (existing M5 AskUserQuestion path, nothing higher to try);
         `cycle-cap` → same-tier (opus-max) retry until attempts
         budget exhausted.
       - `attempts >= max-attempts` with no approval → human
         escalation regardless of last exit type.

    5. Brief worked examples showing (a) all-stuck ladder climb,
       (b) all-cycle-cap same-tier drain, (c) mixed stuck+cap where
       opus-max cycle-caps exhaust budget.

    6. What M7 does NOT add: per-task `model_profile` field in
       BOARD, `/ccx:plan` model inference, `--start-effort` override.
       Those are explicitly deferred — list them as "out of scope
       for M7" so a future M8 design has a starting point.

    Style notes:
    - Match the §-and-subsection depth of M5 (which is the most
      recent analogous milestone — new behavior with new flags +
      exit-signal handling).
    - Include a small Mermaid or ASCII table for the ladder.
    - No implementation code — this is the SSOT for T-2 to implement
      against.

- id: T-2
  title: "M7 implementation: supervisor.md flags, ladder, escalation"
  scope:
    include:
      - plugins/ccx/commands/supervisor.md
    exclude: []
  status: assigned
  priority: normal
  depends_on:
    - T-1
  brief: .ccx/tasks/T-2.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-2"
  branch: "ccx/T-2"
  worker_pid: null
  started_at: "2026-04-22T14:59:40Z"
  finished_at: null
  exit_status: null
  notes: |
    Implement M7 in plugins/ccx/commands/supervisor.md per the design
    in docs/supervisor-design.md §15 (landed by T-1). Touch points:

    - Frontmatter `argument-hint`: add `[--max-attempts N]`,
      `[--worker-loops N]`, `[--start-tier <alias>]`.
    - Argument parsing (near existing `--parallel N` / `--max-tasks M`
      handling): parse three new flags with the defaults from §15;
      validate `--start-tier` enum against the 5-rung alias list;
      validate `--max-attempts` and `--worker-loops` are positive
      integers.
    - Per-worker tier state: the RUNNING[TASK.id] record grows a
      `tier` field initialized to `--start-tier` on first dispatch.
      No BOARD schema change — the tier is derived at re-dispatch
      time from `RUNNING[id].tier` (in-memory) plus the exit signal.
    - Dispatch (P2 step 4) — the `claude -p` one-liner gains
      `--model <tier.alias>` and `--effort <tier.effort>`; the
      embedded `/ccx:loop` invocation gains `--loops <worker-loops>`
      (preserving any existing `--worktree --commit --chat` flags).
    - Stuck recovery path (currently in P2.5): before the existing
      "mark blocked or re-dispatch" logic, compute the next tier:
      if current tier < opus-max → re-dispatch at tier+1. If current
      tier == opus-max → fall through to human escalation (unchanged).
      Respect the `attempts < max-attempts` guard on every
      re-dispatch path.
    - Cycle-cap recovery: detect cycle-cap vs stuck by inspecting
      the worker's final chat_close status + message. A non-stuck
      non-approved exit that indicates cycle-cap (no forward progress
      signal but findings weren't repeating) → re-dispatch at the
      SAME tier.
    - Stuck-vs-cap precedence: if both could fire (all 3 loop cycles
      shared a finding AND loops were exhausted), treat as stuck.
    - When attempts exhaust: existing M5 human escalation path
      applies unchanged.

    Out of scope:
    - No changes to BOARD.md schema.
    - No changes to plan.md or /ccx:plan behavior.
    - No changes to /ccx:loop or /ccx:forever frontmatter (per
      the design note that these are single-session slash commands
      that can't self-re-model).
    - No commit-footer rewrite (the "Opus 4.6" hardcoding in
      loop.md:259 / forever.md:259 is tracked separately).

    Verification inside the worker:
    - Re-read supervisor.md after edit and check that the new flags
      are documented consistently between frontmatter, argument
      parsing, P2 dispatch, and the stuck/cap branches in P2.5.
    - Grep for any lingering references to pre-M7 "fixed-tier"
      assumptions and update them.
    - No tests exist to run for supervisor.md (it's a slash-command
      spec doc, not code); verification is by Codex review.

- id: T-3
  title: "Bump ccx to v0.3.4 — M7 tier escalation shipped"
  scope:
    include:
      - plugins/ccx/.claude-plugin/plugin.json
    exclude: []
  status: assigned
  priority: normal
  depends_on:
    - T-2
  brief: .ccx/tasks/T-3.md
  attempts: 1
  worktree: "/home/will/Repositories/ccx-loop-T-3"
  branch: "ccx/T-3"
  worker_pid: null
  started_at: "2026-04-22T23:42:19Z"
  finished_at: null
  exit_status: null
  notes: |
    Bump plugins/ccx/.claude-plugin/plugin.json version from 0.3.3
    to 0.3.4 and extend the `description` field with a short mention
    of M7 tier escalation (model tier ladder + escalation flags).
    Trivial one-file edit kept separate from T-2 so the M7 impl
    commit stays focused on supervisor.md.

    Out of scope: changes to package.json (repo-level, separate
    versioning). No CHANGELOG since this repo doesn't maintain one.
```
