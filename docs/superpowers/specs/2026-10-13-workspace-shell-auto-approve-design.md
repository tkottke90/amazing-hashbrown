# Workspace Auto-Approve for Shell Commands — Design

## Problem

Running a task against a GitHub issue end-to-end surfaced a usability gap: every
`shell_exec` call that isn't covered by the configured allowlist raises an
approval `interrupt()`, pausing the task into `waiting_on_user`. For a task
doing real unattended work, this means an approval prompt every few seconds —
the opposite of "autonomous." There is no way today to tell a workspace "I
trust you, keep going" short of pre-populating a large allowlist by hand.

## Goal

Give a workspace an "Auto" mode: a one-click, per-workspace setting that skips
the interactive approval step for `shell_exec` calls that would otherwise
require it, while keeping the denylist as a real backstop — not a full
trust-all bypass.

## Non-goals

- Not touching `ask_user` or any other HITL interrupt type — `shell_exec` is
  the only tool in this codebase that raises an approval interrupt today.
- Not a security sandbox. The denylist is a tripwire for obvious, destructive
  mistakes, not a defense against a determined or prompt-injected adversary —
  see "Default denylist" below for the explicit limitation.
- Not building a dedicated audit-log UI. The existing thread transcript
  already records every `shell_exec` call (approved or not) as a
  `tool_call_start`/`tool_call_end` pair, which remains the review surface.
  Revisit only if a real need for the raw audit table shows up later.
- Not a global or per-task setting — scoped to the workspace, per the
  decision below.

## Design

### 1. Data model

Add a new typed column to `Workspace` (`api/src/services/workspace-store.ts`):

```ts
autoApproveShell: boolean;
```

This follows the existing convention for workspace flags (`javascript`,
`python`, `git`) — a typed column per flag, not a generic settings bag, per
this repo's composition-over-configuration principle. A migration adds the
column with `DEFAULT 0`: every existing workspace stays in
approve-every-time mode until a user opts in.

`NewWorkspaceInput` and `PatchWorkspaceInput` gain the matching optional
field. No new route is needed — the existing `PATCH /api/v1/workspaces/:id`
handler already patches arbitrary fields through `patchWorkspace`.

`WorkspaceChatContext` (`api/src/agents/chat-agent.ts`) — already built once
per workspace via `buildWorkspaceContext()` and shared by both interactive
workspace chat and task runs (every `makeShellExecTool(...)` call site
already reads `workspaceContext.location` from it) — gains one more field:

```ts
autoApproveShell: boolean;
```

sourced directly from the workspace record. Because both chat and task
execution already consume this same context object, this single field
addition is sufficient to make Auto mode apply uniformly to both surfaces,
per the decision that it's a workspace-level trust setting rather than a
per-surface one.

Plain (non-workspace) chat has no workspace to attach trust to and is
unaffected — those `shell_exec` calls keep asking every time, same as today.

### 2. Executor / tool wiring

`ShellExecutorOptions` (`lib/shell-executor/src/shell-executor.ts`) gains a
new, distinct field:

```ts
autoApprove?: boolean
```

This is **not** `trustAll`. `trustAll` already has one consumer — the Skills
Manager's pre-vetted script executor (`api/src/index.ts`) — which wants zero
policy involvement at all, including the denylist. Changing `trustAll`'s
semantics to "mostly trust but still check the denylist" would silently
change that existing, already-shipped behavior. Two callers wanting two
different things get two different flags.

Inside `ShellExecutor.execute()`, `evaluatePolicy()` still runs unconditionally,
exactly as it does today:

- `denied` → still denied, always. `autoApprove` never bypasses this.
- `allowed` → still runs silently, unchanged.
- `requires-approval` → today this checks the in-memory session allowlist,
  then falls through to `onApprovalRequired` / `interrupt()`. With
  `autoApprove: true`, it skips straight to execution instead of calling
  `onApprovalRequired` — no `interrupt()`, no graph pause, no
  `waiting_on_user`.

Auto-approved commands are audited with a new, distinct `source: 'auto'`
value (alongside the existing `'policy' | 'session-memory' | 'user' |
'trust'`), so a later review of the audit trail can tell exactly _why_ a
command ran: a human clicked approve, a skill script was pre-vetted, or the
workspace trusted it. `source: 'auto'` is never conflated with `'trust'` or
`'session-memory'`.

`makeShellExecTool` (`api/src/agents/tools/shell-exec.tool.ts`) gains an
`autoApprove` field on `ShellExecToolOptions`, passed straight into the
`ShellExecutor` constructor. Every existing call site that passes
`workspaceContext.location` also passes `workspaceContext.autoApproveShell` —
one new field threaded alongside a plumbing path that already exists, not a
new one.

The in-memory per-thread session allowlist ("approve and remember") is
untouched. It continues to exist for workspaces _not_ in Auto mode; the two
mechanisms coexist.

### 3. Default denylist

`ShellExecutorConfigSchema.denylist` (`lib/shell-executor/src/config.ts`)
defaults to `[]` today, which means "the denylist is still the backstop" is
currently vacuous for most users. We seed a small, non-empty default:

- **Resource exhaustion:** `:(){ :|:& };:` (fork bomb)
- **Unscoped destructive filesystem ops:** `rm -rf /`, `rm -rf /*`, `rm -rf ~`
- **Disk/block devices:** `mkfs.*`, `dd *of=/dev/*`, `wipefs *`, `shred *`,
  `fdisk /dev/*`, `parted /dev/* rm*`
- **Blast-wide permissions/ownership:** `chmod -R 777 /`, `chmod -R 777 /*`,
  `chown -R * /`
- **Host/container availability:** `reboot`, `shutdown *`, `halt`,
  `poweroff`, `init 0`
- **Remote-fetch-into-shell:** `curl * | sh*`, `curl * | bash*`,
  `wget * -O- | sh*`
- **Force-push / history rewrite:** `git push --force*`, `git push -f*`
- **Uncommitted-work wipe (common agent footgun, this harness is git-heavy):**
  `git clean -fdx*`, `git clean -fd*`

This is additive to the schema default, applies to every workspace (not just
Auto-mode ones), and remains fully editable in the existing allowlist/denylist
settings UI (`tools-panel.tsx`) — a user can trim or extend it per their own
risk tolerance.

**Explicit limitation:** `evaluatePolicy`'s glob matcher
(`lib/shell-executor/src/policy.ts`) matches the literal command string,
anchored start-to-end. It catches the naive form of each command above. It
does **not** catch `sudo rm -rf /`, `bash -c "rm -rf /"`, variable-substituted
forms, piped/base64-obfuscated commands, or anything wrapped in another
invocation. This denylist is a tripwire against ordinary mistakes, not a
security boundary against a determined or prompt-injected actor. That
limitation already existed before this feature; Auto mode just makes it the
only backstop in play for `requires-approval` commands, so it's worth being
explicit about rather than letting "the denylist still applies" imply more
safety than it delivers.

### 4. UI

**Toggle.** `ChatInput`'s existing "add" menu (`ui/src/components/chat-input.tsx`,
the `Plus`-icon `DropdownMenu`) gains a new item — rendered only when the
thread is workspace-scoped, same conditional pattern already used for
"Edit tools" (`{threadId && ...}`). Toggling it calls
`patchWorkspace(workspaceId, { autoApproveShell: !current })` via the
existing `use-workspaces.ts` hook — no new endpoint.

**Chip.** Reuses `CardBadge` (`ui/src/components/card-badge.tsx`), already
used in this same file for the skill-menu's "repo" badge — following an
established in-file pattern rather than adding a third hand-rolled chip
style (two already exist in `chat-input.tsx`: `ChatInputChip` and the inline
model-name `<span>`). Rendered next to the existing model chip when
`workspace.autoApproveShell` is true, with an `amber` variant to visually
distinguish "this workspace won't ask before running shell commands" from
the neutral model-name chip beside it. Clicking the chip toggles it off
directly, mirroring the "one click, no confirmation" decision already made
for turning it on.

### 5. Error handling & edge cases

- **Mid-run toggle.** `autoApproveShell` is read from the workspace record at
  tool-construction time per agent build, the same way `location` already
  is — so flipping it takes effect on the very next `shell_exec` call, not
  just the next run. No special-casing needed.
- **Toggling during an active `waiting_on_user` pause.** A task already
  parked on an approval interrupt (raised before Auto was enabled) is
  unaffected — it's a live LangGraph interrupt waiting for a specific resume
  answer. Turning Auto on doesn't retroactively answer it; the user resolves
  that one prompt normally. Unchanged, existing behavior.
- **Denylist hits in Auto mode.** Unchanged tool-result string
  (`Command denied by policy: ...`) — the agent sees a denial and has to
  route around it or report back, exactly as in non-Auto mode. No new
  failure mode.

## Testing

Per the root `AGENTS.md` testing conventions:

- **Unit (`lib/shell-executor`):** `ShellExecutor.execute()` with
  `autoApprove: true` — a `requires-approval` command runs without
  `onApprovalRequired` ever being invoked (spy assertion), audited with
  `source: 'auto'`; a `denied` command is still denied even with
  `autoApprove: true` (denylist precedence); `allowed` is unchanged. New
  default-denylist patterns get their own `evaluatePolicy` cases — one per
  category, asserting both a match and a clear non-match (e.g. `rm -rf /`
  denied, `rm -rf ./node_modules` not).
- **Unit (`shell-exec.tool.ts`):** `makeShellExecTool` threads
  `options.autoApprove` into the constructed `ShellExecutor` — extend the
  existing stubbed test file.
- **Orchestration (`workspace-store.test.ts`):** `patchWorkspace` persists
  `autoApproveShell`; a migration test (alongside the existing
  `db-migrations.test.ts` pattern) confirms the column exists and defaults to
  `false`/`0` for pre-existing rows.
- **Orchestration (task-execution / chat-agent):** a task run built against a
  workspace with `autoApproveShell: true` and a `requires-approval`-shaped
  command never reaches `waiting_on_user` / `interrupt()`, where the
  equivalent non-Auto case would pause.
- **E2E (`@user-workflow`):** toggle Auto on via the add menu, confirm the
  chip appears next to the model chip; run a task whose command would
  normally require approval and confirm no approval card appears in the
  thread; toggle the chip itself back off and confirm the next such command
  does prompt. Per `e2e/AGENTS.md`'s mocking guidance, mock the `shell_exec`
  tool-call/response via `page.route()` rather than relying on a real LLM to
  pick a specific command — this is exactly the HITL-adjacent case that
  guidance calls out.
