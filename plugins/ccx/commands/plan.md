---
description: "Seed or append BOARD.md task rows from free-form input (prompt or document). Entry point for /ccx:supervisor — M6."
argument-hint: "<prompt> | --from <path> [--append]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /ccx:plan — BOARD.md scaffolding from free-form input

Take a free-form prompt or a document the human already wrote (PRD, design note, ticket export, CLAUDE.md-style note — any format), explore the repo to ground `scope.include` globs on actual files, and write `BOARD.md` task rows as `status: draft`. The human reviews the draft, edits if needed, flips `draft → pending`, and then runs `/ccx:supervisor`.

This command is the `/ccx:supervisor` onboarding path (see §14 of `docs/supervisor-design.md`). Without it, the only route to a valid `BOARD.md` is hand-authoring YAML from the design doc — the onboarding cliff M6 closes.

Raw arguments: `$ARGUMENTS`

---

## Argument Parsing

- Positional text (everything that is not a recognized flag) is the **prompt**. One of `<prompt>` or `--from <path>` must be supplied — not both. Supplying neither is an error.
- `--from <path>` — read the file at `<path>` (relative to the repo root or absolute) as the planning context. Use this when the user already wrote a PRD / design note / ticket export and wants plan to decompose it.
- `--append` — extend an existing `BOARD.md` by appending new `draft` rows at the **end** of the `## Tasks` YAML block. Existing rows (regardless of status) MUST be preserved byte-for-byte; plan never modifies them.

**Mode matrix:**

| Mode | BOARD.md present? | Behavior |
|---|---|---|
| default (no `--append`) | absent | Create a fresh `BOARD.md` with a `## Direction` section and a `## Tasks` YAML block containing every planned row as `status: draft`. |
| default | present | STOP: `BOARD.md already exists — re-run with --append to add more draft rows, or edit BOARD.md by hand.` Do not overwrite — a silent overwrite would destroy human edits and merged-task history. |
| `--append` | absent | STOP: `BOARD.md not found — drop --append to create one from scratch.` Keeps append semantics strict and predictable. |
| `--append` | present | Parse the existing YAML block, compute `NEXT_ID = max(existing T-N ids) + 1`, append new rows starting at `NEXT_ID`. `## Direction` is left untouched (plan never rewrites human-authored prose). |

No other flags for M6. Direction-only updates and row-editing are manual — the user edits `BOARD.md` by hand.

---

## Guardrails

- Plan MUST NOT push, force-push, amend, `git reset --hard`, or create branches — it only writes `BOARD.md` (and commits it on the current branch).
- Plan MUST NOT write `.ccx/tasks/*.md` brief files. The supervisor creates briefs at dispatch time (§6.1 of the design doc). If plan wrote briefs here, they would bypass the draft-review gate.
- Plan MUST NOT set any task row to `status: pending` — every new row is `draft`. The `draft → pending` transition is the human's review act and is explicitly gated (see §14.3.3).
- `scope.include` globs MUST be **grounded on actual repo files**. For each proposed glob, run `git ls-files -z -- <glob>` and record the match count. If a glob matches zero files, that is allowed (the task may create new files) BUT the task's `notes` field MUST say so explicitly so the human catches hallucinated scopes on review. Ungrounded scopes cause the supervisor's M4 overlap gate to misfire at dispatch time — worse than no plan.
- `scope.include` globs MUST pass the same contract enforced by `/ccx:supervisor` P1 step 2: non-empty strings, no NUL byte, no newline. Plan runs the pathspec sanity probe (`git ls-files -z -- <glob>`) on each glob to catch malformed pathspecs before the human ever sees them.
- Plan MUST NOT modify any existing task row in `--append` mode — not even to normalize whitespace or re-order keys. The existing YAML block is edited by inserting new rows immediately before the closing fence; prior bytes are left alone.
- Every emitted row MUST have a stable `id` of the form `^T-[0-9]+$`. IDs are monotonic from `max(existing) + 1` — never reused even if a prior row was removed, because brief filenames and branch names key off the id (§14.3.4).
- Task count is bounded: emit between **1 and 25** rows per invocation. Under 1 is a planning failure; over 25 is almost certainly under-decomposition noise rather than a real plan and should trigger a refusal with the offer to re-run on a narrower scope.

---

## Phase 0: Pre-check

1. Resolve repo root: `REPO_ROOT="$(git rev-parse --show-toplevel)"`. If not inside a git repo, STOP with `/ccx:plan must be run inside a git repository`.

   **Repo-root anchoring (load-bearing for this command).** From this step onward, every `git …` invocation MUST be anchored to `REPO_ROOT` — use the `git -C "$REPO_ROOT" …` form for every git subcommand in every subsequent phase. Bare `git …` without `-C` resolves pathspecs (`BOARD.md`, `<glob>`, etc.) relative to the caller's current directory, which breaks two contracts the supervisor later relies on:
   - `scope.include` globs in `BOARD.md` are evaluated by `/ccx:supervisor` from `REPO_ROOT` (see its M4 overlap gate in supervisor.md §P2.4). If plan grounds a glob from a subdirectory, the match set it validates against is a different set than the supervisor will see at dispatch — the persisted scope would be semantically wrong.
   - `BOARD.md` lives at `REPO_ROOT/BOARD.md`. If plan runs `git status -- BOARD.md`, `git add -- BOARD.md`, or `git show HEAD -- BOARD.md` from a nested directory, the pathspec resolves to `<cwd>/BOARD.md` — potentially a different (likely absent) file — so the dirty check, the stage, and the diff report can all target the wrong path.

   The `-C "$REPO_ROOT"` prefix makes every command below behave as if invoked from the repo root regardless of where the user actually ran `/ccx:plan` from. The quoting matters: `"$REPO_ROOT"` may contain spaces on platforms where the repo is checked out under a path like `~/Client Projects/foo`. Treat any path mentioned in `Read` / `Write` / `Edit` calls the same way — always pass `REPO_ROOT/BOARD.md` as an absolute path, never a bare `BOARD.md`.
2. Verify that **`BOARD.md` specifically** is not dirty in the working tree. Only this one file matters, not the rest of the tree:
   - Run `git -C "$REPO_ROOT" status --porcelain=v1 -z -- BOARD.md`. If the output is empty, proceed.
   - If non-empty (BOARD.md is modified, staged, or both), STOP with: `BOARD.md has uncommitted changes — commit or stash them before running /ccx:plan (plan would overwrite or append to those edits).` Default mode would clobber the edits with a fresh Write; append mode would Edit them and risk silent mis-insertion around a shifted closing fence.

   **Do NOT gate on the rest of the working tree.** Unrelated uncommitted edits — most importantly the `--from <path>` source document itself when the user just wrote it in the repo — are fine. Phase 3's `git add -- BOARD.md` stages only `BOARD.md`, so no other dirty path can contaminate the plan commit. This permissiveness is load-bearing for the headline `--from` workflow: the user writes a PRD in the repo, runs `/ccx:plan --from docs/prd.md`, and sees their draft turned into task rows. Forcing the PRD to be committed first would kill that flow.
3. Parse the arguments above into `INPUT_MODE ∈ {prompt, from}`, `APPEND ∈ {true, false}`, `INPUT_RAW` (the prompt string or the contents of `--from <path>`), and `INPUT_LABEL` (`"prompt"` or `"from <path>"`).
4. Resolve `BOARD_PATH = REPO_ROOT/BOARD.md`. Apply the mode matrix above. STOP on the error cases listed there.
5. If `INPUT_MODE == "from"`:
   - **Normalize the path against `REPO_ROOT` first.** The `--from <path>` flag accepts absolute paths verbatim, but any relative path MUST be resolved against `REPO_ROOT` rather than the caller's current directory. If the raw path starts with `/` (Unix) or matches `^[A-Za-z]:` (Windows drive letter), treat it as absolute and use it as-is; otherwise compute `FROM_PATH="$REPO_ROOT/<path>"`. Without this normalization, a user who runs `/ccx:plan --from docs/prd.md` from a subdirectory like `apps/web/` would get a file-not-found error even though `docs/prd.md` exists at the repo root — the same subdirectory-invocation hazard the repo-root anchoring rule in step 1 exists to close.
   - Verify the normalized path exists and is readable (`test -r "$FROM_PATH"`). STOP if not, reporting `FROM_PATH` (the normalized absolute form) so the user can see exactly which location was checked.
   - Read the file with `Read` using `FROM_PATH` (absolute). No offset/limit — plan needs the whole document. If the file exceeds ~80KB, emit a warning: plan may summarize rather than decompose faithfully. Do not hard-fail — respecting the user's existing document is the point.

If anything fails, print the exact error and stop. No partial writes, no partial commits.

---

## Phase 1: Ground the plan on repo reality

The single biggest failure mode is hallucinated scopes — decomposing a task into `src/auth/oauth.ts` when the repo actually organizes auth under `packages/server/auth/*`. Every glob in every proposed `scope.include` MUST be grounded on actual files. Do this BEFORE emitting any rows.

1. **Top-level map.** Run:
   - `git -C "$REPO_ROOT" ls-files -z | head -c 8192` — a byte-capped listing of tracked files (the cap keeps very large repos' output manageable; plan does not need every path, just enough to identify package layouts and naming conventions).
   - `Read` `REPO_ROOT/README.md` if it exists.
   - `Read` `REPO_ROOT/CLAUDE.md` if it exists (project instructions often state where code lives and the preferred decomposition granularity).
   - If the repo has a monorepo layout (presence of `packages/`, `apps/`, `services/`, `crates/`, etc. in the ls-files output), `Glob` the top level of each to learn the sub-package names.
2. **Input analysis.** Read `INPUT_RAW` and extract candidate **units of work** — each unit is one deliverable slice that could plausibly be a single `/ccx:loop` run (scope: one feature, one refactor, one bugfix, one doc slice). Prefer slicing by *outcome*, not by *layer* — `add OAuth2 login flow` is one task, not three (backend / frontend / docs as separate tasks fragment scope and defeat the supervisor's per-task worktree model).
3. **Glob grounding.** For each candidate unit, draft a tentative `scope.include` list of 1–5 globs. For each glob:
   - Run `git -C "$REPO_ROOT" ls-files -z -- <glob>` (argv form, NOT shell-interpolated — the glob is a Git pathspec, not a shell glob; `git -C "$REPO_ROOT" ls-files -- 'src/**/*.ts'` is correct, `git -C "$REPO_ROOT" ls-files -- src/**/*.ts` lets the shell expand `**` and produces wrong results). The `-C "$REPO_ROOT"` prefix is mandatory here: supervisor evaluates `scope.include` globs from `REPO_ROOT` at dispatch time, so plan's grounding must use the same base directory or the persisted globs will match a different file set at dispatch than they did at plan time.
   - Record the match count. If zero, either narrow the glob (common cause: typo / wrong extension / wrong monorepo package) or keep it and note in the row's `notes` field that the task creates new files at this path.
   - Run the same command with `Grep` or `Glob` to cross-check — if `Glob` returns matches but `git ls-files` does not, the file is untracked and the scope likely needs `git add` first (surface this in `notes`).
4. **Dependency inference.** If two candidate units obviously depend on each other (e.g. "add DB migration for X" must land before "add service that reads X"), record the dependency as `depends_on: [T-<id>]`. Keep dependencies conservative — false positives serialize tasks that could run in parallel. Prefer an empty `depends_on` when unsure; the human can add deps on review.
5. **Cap check.** Count the candidate units. If under 1 or over 25, STOP with:
   - Under 1: `input did not decompose into any tasks — try a more concrete prompt or narrower document scope`.
   - Over 25: `input decomposed into <N> tasks — too many for one plan. Re-run with a narrower slice, or split the document into sections and run --append per section`.

Output of this phase: an in-memory list `PLANNED_TASKS` with fields `{ title, scope_include (grounded globs + match counts), depends_on (forward-references by position), notes (≤500 chars, explicit about zero-match globs and new-file creation) }`.

---

## Phase 2: Emit BOARD.md

### 2a. Fresh-seed mode (no `--append`, no existing BOARD.md)

Write `REPO_ROOT/BOARD.md` with exactly this structure (no leading/trailing blank lines beyond what is shown; Markdown is whitespace-sensitive for the supervisor's parser):

```markdown
# BOARD

## Direction

{{2–5 sentences summarizing project-wide priorities derived from INPUT_RAW.
If INPUT_RAW does not suggest direction-level content (e.g. a narrow bug-fix
prompt), leave this section with a single line: "_(plan did not infer
direction — edit by hand if supervisor needs project-wide context)_". Never
invent direction content; absence is better than confabulation.}}

## Tasks

```yaml
{{YAML array of PLANNED_TASKS rendered per §2c below, starting at id T-1}}
```
```

**Nested fence caveat.** The YAML block lives inside a triple-backtick fence, and the enclosing markdown spec here uses triple-backtick fences too. When actually writing `BOARD.md`, emit the outer markdown as plain text and the YAML block as a literal ` ```yaml ... ``` ` fenced section — the markdown above is a template preview, not a literal file. The supervisor's P1 parser requires exactly one fenced block under `## Tasks` containing a YAML array; any additional fenced blocks under that heading will break parsing.

Forward-reference resolution: `depends_on` entries recorded as positional forward-references in Phase 1 step 4 must be rewritten to concrete `T-<id>` values before emission (every row's position `i` maps to id `T-<i+1>` when starting at 1). Resolve these in a single pass after assigning ids, then emit.

### 2b. Append mode (`--append`, existing BOARD.md)

1. `Read` the existing `BOARD.md`.
2. Locate the `## Tasks` heading. If absent, STOP with `BOARD.md has no ## Tasks section — /ccx:plan --append can only extend an existing task block. Edit BOARD.md by hand to add the heading + an empty yaml block first.`
3. Locate the opening ` ```yaml ` fence on the line after `## Tasks` (allowing one blank line between) and the matching closing ` ``` ` fence. If either fence is missing, STOP with the same guidance as step 2 — append mode requires a well-formed fenced block (even an empty one). An **empty YAML block** is explicitly allowed and supported: it is a common intermediate state (a human seeds a direction-only `BOARD.md` by hand and then runs `/ccx:plan --append` to add the first tasks). "Empty" here means any of three shapes: (a) fences with only whitespace between them; (b) a literal `[]` body; (c) fences containing only YAML comments (lines starting with `#`).
4. **Fast-path blank bodies before the YAML parse.** Extract the raw text between the opening and closing fences. Strip comments (any line whose first non-whitespace character is `#`). If the stripped result is only whitespace, OR is exactly `[]` (ignoring surrounding whitespace), OR would parse to YAML `null`, treat the block as `EXISTING_TASKS = []` and `EXISTING_IDS = []` directly — do NOT feed the raw text to a YAML parser in this case. A whitespace-only YAML document parses to `null`, not `[]`, so a naive "parse, then treat as array" pipeline would either crash on `null.forEach(...)` or wrongly reject the documented direction-only case. Only when the stripped body contains at least one non-comment, non-whitespace character (a `-` bullet or a `{`) do we proceed to an actual YAML parse. Extract `EXISTING_IDS = [T-<n> for each task with id matching ^T-[0-9]+$]`. Compute `MAX_ID_N = max(numeric suffix of each existing id, default 0)` — the `default 0` covers the empty-block fast-path so the first new task becomes `T-1`. The first newly-emitted task gets `id = T-<MAX_ID_N + 1>`, next is `T-<MAX_ID_N + 2>`, and so on — **never reuse an id even if it appears in `EXISTING_IDS` as a removed-but-still-referenced entry**, because brief filenames and branch names key off the id.
5. Resolve forward-reference `depends_on` entries against the new ids (Phase 1 step 4 entries reference other planned tasks by position; `depends_on` may also legitimately reference an existing `EXISTING_IDS` entry if Phase 1 identified a dependency on already-seeded work — record those verbatim).
6. **Render every new task** to a YAML text block per §2c below.
7. **Use `Edit`** to insert the new YAML text immediately before the closing ` ``` ` fence, preserving the existing fence position and every existing task entry byte-for-byte. Do NOT re-write the entire block — an Edit-based insert is the only way to guarantee existing rows are untouched (Write-based full-file rewrite is forbidden in append mode).
   - **Non-empty block:** anchor the `Edit` on the last existing task's final line + the closing fence. If the existing block has trailing whitespace or unusual formatting that makes the anchor ambiguous, narrow the anchor until it is unique.
   - **Empty block** (literal `[]` body, or fences with only whitespace between them): anchor the `Edit` on the opening fence + the empty body + the closing fence as one contiguous region, and replace it with the opening fence + the new YAML rows + the closing fence. A literal `[]` body must be replaced by the new rows, not preserved — a YAML block can't validly contain both `[]` and task entries.
   - Never use `replace_all` in this command.
8. Do NOT touch `## Direction` or any other section of the file.

### 2c. YAML row template

Every emitted row MUST match this shape exactly:

```yaml
- id: T-<n>
  title: "<short human-readable title — one line, ≤80 chars>"
  scope:
    include:
      - <grounded glob 1>
      - <grounded glob 2>
    exclude: []
  status: draft
  priority: normal
  depends_on: []
  brief: .ccx/tasks/T-<n>.md
  attempts: 0
  worktree: null
  branch: null
  worker_pid: null
  started_at: null
  finished_at: null
  exit_status: null
  notes: |
    <1–3 sentences of intent. MUST explicitly note:
     - any glob in scope.include that matched zero files (task will create new files)
     - any assumption that needs human validation ("assumed DB uses PostgreSQL — confirm before flip")
     - the source of this task in INPUT_RAW (for --from mode, a section reference;
       for prompt mode, the phrase that triggered this task)>
```

Rules:
- `status: draft` — hardcoded. Never `pending`, never any other value.
- `priority: normal` — hardcoded for M6. Humans adjust priority on review.
- `depends_on: []` by default; populated with ids only when Phase 1 step 4 inferred a dependency.
- `brief: .ccx/tasks/T-<n>.md` — standard path (§6.1 of the design doc). No brief file is created at plan time; supervisor creates it at dispatch.
- `attempts: 0` and every `*_at` / `worker_pid` / `exit_status` / `worktree` / `branch` field are `null` / `0` as shown — supervisor-managed runtime state, placeholders only.
- `notes:` — use the YAML literal block scalar (`notes: |`) for multi-line notes. Single-line notes can use the plain form (`notes: "..."`), but the block form is always safe.

After emission, `Read` the file back and verify:
- `## Tasks` appears exactly once.
- Exactly one fenced YAML block appears immediately under `## Tasks`.
- Every new row's `status` is `draft`.
- In append mode, every `EXISTING_IDS` entry still appears verbatim in the file (byte-for-byte substring match).

If any check fails, STOP — do NOT commit. Leave the modified `BOARD.md` on disk so the user can inspect and re-run.

---

## Phase 3: Commit

Stage and commit exactly one file. The commit MUST be path-limited to `BOARD.md` so that any unrelated paths the user happened to have in the index (from before invoking `/ccx:plan`) are NOT swept into the plan commit — Phase 0's dirty-tree check only refuses a dirty `BOARD.md`, so the rest of the index could contain pre-existing WIP and a bare `git commit` would publish it:

```bash
git -C "$REPO_ROOT" add -- BOARD.md
# `git commit -- <paths>` uses --only semantics: it snapshots the on-disk
# contents of the specified paths (ignoring whatever else is staged),
# commits exactly those paths, and leaves any other staged entries in the
# index untouched after the commit. This enforces the "exactly one file"
# contract regardless of what the user had staged before running plan.
git -C "$REPO_ROOT" commit -m "$(cat <<'EOF'
supervisor: plan draft

<one-line summary of what was planned — e.g. "seeded 7 tasks from prompt: add OAuth2 login flow"
or "appended 3 tasks from docs/prd-feature-z.md">
EOF
)" -- BOARD.md
```

Commit-message contract:
- **Subject** is always `supervisor: plan draft` — the `/ccx:supervisor` P0 / P2.1 / audit tooling keys log scans off the `supervisor:` prefix; a different subject would bypass those scans.
- **Body** is a one-line summary of the planning action (count of tasks added + input source). No trailing blank lines.
- No `Co-Authored-By` line — plan is a deterministic tool action, not a coding contribution. (Loop/forever commits include the Claude co-author because those commits contain Claude-authored code changes; plan commits contain only structured metadata and do not need the attribution.)

If the commit fails (pre-commit hook rejects `BOARD.md` edits, signing failure, branch protection):
1. Do NOT retry with `--no-verify` — hooks exist for a reason.
2. Leave `BOARD.md` modified on disk (unstaged or staged, depending on where the hook rejected).
3. STOP and tell the user: `commit failed — BOARD.md is modified on disk; resolve the hook failure, then stage and commit manually`.

---

## Phase 4: Report

After a successful commit, print:

1. A one-line header: `planned <N> tasks — T-<first>..T-<last>, status: draft`.
2. The diff introduced by the plan commit — use `git -C "$REPO_ROOT" show HEAD -- BOARD.md`, NOT `git diff HEAD~1 -- BOARD.md`. `git show HEAD` works whether or not `HEAD~1` exists, so it correctly handles the case where `/ccx:plan`'s commit is the very first commit in a freshly initialized repository (`HEAD~1` would be an invalid revision and would fail the report after the real work succeeded). The `-C "$REPO_ROOT"` prefix ensures the pathspec resolves to the repo-root `BOARD.md` even when the user invoked `/ccx:plan` from a nested directory.
3. Per-task summary: `T-<id>  <title>  (scope: <file-count> files across <glob-count> globs)`. If any glob matched zero files, append `  [new-file-scope]` so the human spots it on review.
4. A footer with the exact next steps:

   ```
   Next steps:
     1. Review BOARD.md. Edit any draft row (title, scope.include, depends_on, notes) as needed.
     2. For each task you want to dispatch, change `status: draft` to `status: pending`.
     3. Commit your edits — `/ccx:supervisor` refuses to run on a dirty tree:
          git add -- BOARD.md
          git commit -m "board: review + flip N tasks to pending"
     4. Run `/ccx:supervisor` to dispatch the pending tasks.

   To add more tasks later: `/ccx:plan --append "<prompt>"` or `/ccx:plan --append --from <path>`.
   ```

   The commit step is load-bearing: `/ccx:supervisor` P0 step 3 requires `git status --porcelain` to be empty before it starts dispatching, so any uncommitted review edits to `BOARD.md` (or to files touched while the user was reviewing) will block the supervisor run. Spelling out the `git add` + `git commit` here prevents users from hitting that gate mid-run and having to recover.

This is the exit contract — plan does not run the supervisor, does not set any task `pending`, and does not touch `.ccx/tasks/`.

---

## Relationship to `/ccx:supervisor`

- `/ccx:plan` writes `BOARD.md` rows with `status: draft`.
- `/ccx:supervisor` P1 validator accepts `draft` as a valid status value but **excludes** it from dispatch — the same exclusion as `assigned | review | merged | blocked`. Draft rows never trigger a dispatch, never create briefs, never spawn workers.
- The human's review action is literally editing `BOARD.md` and flipping `draft → pending`. That edit is a normal human commit; supervisor picks up the `pending` rows on its next run.
- If `/ccx:supervisor` is invoked when no `BOARD.md` exists, it STOPs with a pointer back to this command (see supervisor.md Phase P0 step 4).

The two commands have disjoint responsibilities: plan is LLM creativity (decomposition + scope grounding), supervisor is deterministic scheduling (dispatch + merge). Mixing them (a `/ccx:supervisor --plan` flag) was rejected in §14.2 of the design doc because it would degrade the supervisor's deterministic-parser property that M4/M5 rely on.
