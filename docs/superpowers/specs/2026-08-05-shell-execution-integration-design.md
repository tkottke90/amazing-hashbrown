# Shell Execution Integration — Design

**Date:** 2026-08-05
**Status:** Approved
**Depends on:** Agent Skills (Slash Commands)

---

## Goal

Give the agent a bash terminal for running commands, executing scripts, and interacting with its environment. Commands run in a controlled, isolated environment gated by a policy and an approval flow, with results captured as tool calls and all decisions audited.

---

## Architecture

### New package: `lib/shell-executor`

A dedicated library package following the existing lib pattern. Both `api/` and `lib/skills-manager` import from it, so the policy engine, approval callback, and audit trail are defined once and shared.

```
lib/shell-executor/
  src/
    index.ts            ← public exports
    shell-executor.ts   ← ShellExecutor class
    policy.ts           ← pattern-matching engine
    audit.ts            ← AuditEntry type and AuditWriter contract
    config.ts           ← ShellExecutorConfigSchema (Zod) + inferred type
    types.ts            ← ShellCommandResult, ApprovalCallback
  package.json
  tsconfig.json
```

**Public exports:**
- `ShellExecutor` class
- `ShellExecutorConfigSchema` — Zod schema imported by consumers to compose into their own config validation
- `ShellExecutorConfig` — inferred type
- `ShellCommandResult`, `AuditEntry`, `AuditWriter`, `ApprovalCallback` types

---

## Config Schema

The lib exports its own Zod schema so config validation stays co-located with the code that uses it. Consumers compose it into their own schema rather than duplicating field definitions.

```typescript
// lib/shell-executor/src/config.ts
export const ShellExecutorConfigSchema = z.object({
  workingDirectory: z.string().default('/app'),
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default([]),
  env: z.record(z.string()).default({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  }),
});
```

Nested under `tools.shell` in `config.yaml`:

```yaml
tools:
  shell:
    workingDirectory: /app
    allowlist:
      - "git status"
      - "git log *"
      - "git diff *"
      - "npm test"
      - "npm run *"
      - "ls *"
    denylist:
      - "rm -rf *"
      - "sudo *"
      - "git push *"
      - "git reset --hard *"
    env:
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      GH_PAT: ${GH_PAT}   # explicitly map container env vars as needed
```

**Security:** spawned processes receive only what is declared in `env` — no inheritance from `process.env`. Application secrets (API keys, database credentials) are invisible to the shell unless the user explicitly maps them. `PATH` is the sole exception, provided as a schema default so commands resolve out of the box without requiring manual configuration.

The api's top-level config schema composes the shell schema:

```typescript
const ConfigSchema = z.object({
  // ...existing fields
  tools: z.object({
    shell: ShellExecutorConfigSchema,
  }).optional(),
});
```

---

## ShellExecutor Class

```typescript
export class ShellExecutor {
  constructor(
    config: ShellExecutorConfig,
    opts: {
      trustAll?: boolean;
      sessionAllowlist?: string[];
      onApprovalRequired?: ApprovalCallback;
      auditWriter?: AuditWriter;
    }
  )

  execute(command: string, reason?: string): Promise<ShellCommandResult>
}
```

**`trustAll`:** when `true`, policy evaluation and the approval callback are bypassed entirely. The executor still writes audit entries. Used by `SkillsManager` to mark skill-script spawns as pre-vetted at install time.

**`sessionAllowlist`:** patterns approved by the user earlier in the current session (read from thread metadata by the agent tool and passed in at construction time).

**`onApprovalRequired`:** dependency-injected callback invoked when a command requires user approval. The lib has no LangGraph dependency — `interrupt()` lives in the agent tool layer, not here.

**`auditWriter`:** dependency-injected writer for the observability store. Tests pass a spy; the api passes the real observability writer.

### Execution flow

```
execute(command, reason)
  │
  ├─ trustAll? → skip policy, log audit(source: 'trust', outcome: 'allowed'), spawn
  │
  ├─ denylist match? → log audit(source: 'policy', outcome: 'denied'), return error result
  │
  ├─ allowlist match? → log audit(source: 'policy', outcome: 'allowed'), spawn
  │
  ├─ sessionAllowlist match? → log audit(source: 'session-memory', outcome: 'allowed'), spawn
  │
  └─ onApprovalRequired(command, reason)
       ├─ 'approved' / 'approved_remember' → log audit(source: 'user', outcome: 'approved'), spawn
       └─ 'denied' → log audit(source: 'user', outcome: 'rejected'), return error result
```

**Output handling:** stdout and stderr are buffered in full. The process is awaited to completion before returning. No timeout is applied in this iteration.

```typescript
export type ShellCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
```

---

## Policy Engine

```typescript
// lib/shell-executor/src/policy.ts
export function evaluatePolicy(
  command: string,
  config: Pick<ShellExecutorConfig, 'allowlist' | 'denylist'>
): 'allowed' | 'denied' | 'requires-approval'
```

Pure function with no side effects — straightforward to unit test exhaustively.

**Pattern matching:** patterns are matched against the full command string. `*` matches any sequence of characters including spaces, so `"git *"` covers `"git log --oneline"`, `"git diff HEAD~1"`, etc.

**Precedence:** denylist is checked first and always wins. This allows a broad allowlist pattern (`"git *"`) to be narrowed by a specific deny override (`"git push *"`) without conflict.

**Three outcomes:**
- `'allowed'` — matched the allowlist; executes immediately
- `'denied'` — matched the denylist; rejected without involving the user
- `'requires-approval'` — neither list matched; routed to `onApprovalRequired`

---

## Audit Trail

```typescript
// lib/shell-executor/src/audit.ts
export type AuditEntry = {
  timestamp: string;          // ISO-8601
  command: string;            // exactly as requested
  outcome: 'allowed' | 'denied' | 'approved' | 'rejected' | 'error';
  source: 'trust' | 'policy' | 'session-memory' | 'user';
  exitCode?: number;          // present if the process ran
  threadId?: string;          // present for agent-initiated calls
  trustAll: boolean;
};

export type AuditWriter = (entry: AuditEntry) => Promise<void>;
```

Every execution attempt writes an audit entry regardless of outcome. The `lib/observability` SQLite store is the write target — audit entries are the same class of data as tool-call spans. The `auditWriter` is injected at construction so `lib/shell-executor` has no direct dependency on `lib/observability`.

---

## Agent Tool

`api/src/agents/tools/shell-exec.tool.ts` wires `ShellExecutor` to LangGraph.

**Schema:**
```typescript
const ShellExecSchema = z.object({
  command: z.string().describe('The shell command to run'),
  reason: z.string().optional().describe(
    'Why this command is needed — shown to the user if approval is required'
  ),
});
```

**Approval callback** injects `interrupt()` without the lib knowing about LangGraph:

```typescript
onApprovalRequired: async (command, reason) => {
  const answer = interrupt({
    kind: 'shell_approval',
    command,
    reason,
  });
  if (answer === 'approved_remember') {
    await appendSessionPattern(threadId, command);
  }
  return answer === 'denied' ? 'denied' : 'approved';
},
```

Because LangGraph re-runs the tool node from the beginning on resume, `execute()` is called twice for any command requiring approval: the first call reaches `interrupt()` which throws and suspends the graph; the second call (after the user responds) reaches `interrupt()` again, which this time returns the user's answer. This is the same mechanism `ask_user` uses.

**Session memory:** approved patterns are stored in thread metadata keyed by `threadId`. On the second execution (post-resume), the tool reads the updated session patterns before constructing the executor, so an `'approved_remember'` answer is reflected immediately within the same turn.

**Tool result:** a plain string the agent reads back:
```
exit 0
<stdout>
<stderr>
```

The tool is registered in `buildChatAgent()` alongside the existing tools.

---

## SkillsManager Integration

`lib/skills-manager/src/internal/runner.ts` drops its own `spawn` call and delegates to a `ShellExecutor` instance provided by the api layer at startup.

The api constructs a trusted executor once:

```typescript
// api/src/services/skills-manager.ts
const trustedExecutor = new ShellExecutor(shellConfig, {
  trustAll: true,
  auditWriter: observabilityAuditWriter,
  // no onApprovalRequired — trustAll bypasses policy entirely
});
skillsManager.setExecutor(trustedExecutor);
```

`runPythonScript` in `runner.ts` delegates to the executor:

```typescript
export async function runPythonScript(
  skillPath: string,
  scriptPath: string,
  args: string[] = [],
): Promise<ScriptResult> {
  const interpreter = await resolveInterpreter(skillPath);
  const command = buildCommand(interpreter, scriptPath, args);
  return executor.execute(command);
}
```

`runJsScript` is unchanged — it uses Node's `vm` module and does not spawn a process, so there is nothing to route through the executor.

---

## Known Follow-up

**HITL Recovery on Reconnect** (TODO #3): when the server restarts while a shell approval is pending, the LangGraph checkpoint preserves graph state but the frontend loses its SSE connection and does not re-render the pending approval prompt on reconnect. This gap affects all `interrupt()`-based HITL flows (`ask_user`, shell approval). Tracked separately and addressed uniformly — see TODO list item #3 for the proposed `GET /api/v1/threads/:id/status` solution.
