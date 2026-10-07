import { env } from '../api/src/config/env.js';
import { askUserTool } from '../api/src/agents/tools/ask-user.tool.js';
import { makeShellExecTool } from '../api/src/agents/tools/shell-exec.tool.js';
import { uploadImageTool } from '../api/src/agents/tools/upload-image.tool.js';
import { wikiSearchTool } from '../api/src/agents/tools/wiki-search.tool.js';
import { wikiReadPageTool } from '../api/src/agents/tools/wiki-read-page.tool.js';
import { wikiLocateTool } from '../api/src/agents/tools/wiki-locate.tool.js';
import { wikiOrientTool } from '../api/src/agents/tools/wiki-orient.tool.js';
import { makeWikiCreatePageTool } from '../api/src/agents/tools/wiki-create-page.tool.js';
import { wikiLintTool } from '../api/src/agents/tools/wiki-lint.tool.js';
import { makeWikiUpdatePageTool } from '../api/src/agents/tools/wiki-update-page.tool.js';
import { makeWikiAddCrossLinkTool } from '../api/src/agents/tools/wiki-add-cross-link.tool.js';
import { makeWikiRebaselineSourceTool } from '../api/src/agents/tools/wiki-rebaseline-source.tool.js';
import { wikiRegisterDomainTool } from '../api/src/agents/tools/wiki-register-domain.tool.js';
import { webFetchTool } from '../api/src/agents/tools/web-fetch.tool.js';
import { getToolKeyTool } from '../api/src/agents/tools/get-tool-key.tool.js';
import { searchSkillsTool } from '../api/src/agents/tools/search-skills.tool.js';
import { makeCreateWorkspaceTool } from '../api/src/agents/tools/create-workspace.tool.js';
import { makeCreateProjectTool } from '../api/src/agents/tools/create-project.tool.js';
import { makeCreateTasksTool } from '../api/src/agents/tools/create-tasks.tool.js';
import { makeCompleteTaskTool } from '../api/src/agents/tools/complete-task.tool.js';
import { makeUpdatePlanTool } from '../api/src/agents/tools/update-plan.tool.js';
import { makeReadTaskRunTool } from '../api/src/agents/tools/read-task-run.tool.js';
import { scheduleWakeupTool } from '../api/src/agents/tools/schedule-wakeup.tool.js';
import { cancelWakeupTool } from '../api/src/agents/tools/cancel-wakeup.tool.js';
import { buildTaskContextBlock } from '../api/src/agents/task-context.js';
import { buildWorkspaceContextBlock } from '../api/src/agents/chat-agent.js';
import { buildSystemPrompt } from '../api/src/agents/system-prompt.js';
import { buildAmbientContext } from '../api/src/agents/ambient-context.js';
import { fakeGenerateImageTool } from './eval-fixtures.js';
import type { Suite } from '../lib/evaluations/src/index.js';

// Shared by bin/eval.ts and bin/eval-stream-trace.ts so the trace script sends
// the model byte-for-byte what the eval does — tool set and system prompt
// are assembled here once rather than copied into each script.

// The static built-in tool set the production chat agent binds (see
// api/src/agents/chat-agent.ts) — used to give tool-call eval scenarios the
// same choices the real agent has. MCP tools are excluded: they're
// dynamic/live-server-dependent, which would make the eval non-deterministic
// to run. fakeGenerateImageTool is an eval-only fixture (see
// eval-fixtures.ts) — never part of the production agent's tool set.
export const evalTools = [
  askUserTool,
  // Safe to bind here even though it can run real commands: tool-call and
  // tool-sequence scenarios only inspect response.tool_calls — the runner
  // never executes the bound tools (see invokeToolCallModel in runner.ts).
  // wakeupAvailable matches production chat: the sleep-guard refusal
  // (seeded in suites/agent-wait.yaml aw-003) names schedule_wakeup.
  makeShellExecTool(undefined, { wakeupAvailable: true }),
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
  wikiLintTool,
  // Unrestricted (invoked without a thread, so no write scope applies) — the
  // eval runner only inspects proposed tool_calls against seeded turns
  // context, it never actually executes a tool, so this can't exercise the
  // write scope itself (that's what wwrite-005/006-010's seeded rejection
  // results are for).
  makeWikiCreatePageTool(),
  makeWikiUpdatePageTool(),
  makeWikiAddCrossLinkTool(),
  makeWikiRebaselineSourceTool(),
  wikiRegisterDomainTool,
  webFetchTool,
  getToolKeyTool,
  // Part of STATIC_CHAT_TOOLS in production (chat-agent.ts) but was missing
  // here — auto-eval round 1 of suites/tool-calling.yaml (2026-09-22)
  // against local/Lemonade/Ornith/Digital Ocean found all four models never
  // once mentioned search_skills among their own enumerated tool lists when
  // asked "what skills do you have," which only makes sense if it genuinely
  // wasn't bound. Confirmed against chat-agent.ts's STATIC_CHAT_TOOLS array
  // (line ~280), where searchSkillsTool is unconditionally included.
  searchSkillsTool,
  // Skill-gated in production (see chat-agent.ts's skillGatedToolsMiddleware).
  // create-workspace-project.yaml now exercises that real gating directly
  // via each scenario's `gatedSkill` field (see runner.ts and
  // docs/superpowers/specs/2026-08-27-skill-gated-tools-hardening-design.md)
  // — skill-gated-tools.middleware.test.ts still covers the middleware's
  // unit-level behavior on its own. Included here unconditionally, same as
  // every other tool in this list, so any suite/scenario can reference them
  // as an option regardless of whether it opts into gating.
  makeCreateWorkspaceTool(),
  makeCreateProjectTool(),
  // Workspace-scoped in production (buildWorkspaceScopedTools() in
  // chat-agent.ts) — bound in buildWorkspaceChatAgent/buildTaskAgent, never
  // buildChatAgent, unlike every other tool in this list which mirrors
  // STATIC_CHAT_TOOLS/buildGatedTools() (the plain-chat set). Included here
  // unconditionally anyway, same reasoning as searchSkillsTool above: this
  // harness has no separate workspace-scoped tool list, and
  // suites/task-creation.yaml (2026-09-22) is deliberately scoped to
  // workspace chat and needs create_tasks actually offered to be a
  // meaningful test — auto-eval round 1 against all four configured
  // providers found every model reasoning its way around the missing tool
  // (creating wiki pages, asking clarifying questions, checking for
  // existing tasks via shell_exec) rather than ever seeing create_tasks as
  // an option, confirming it genuinely wasn't bound.
  makeCreateTasksTool(),
  // Task-run-only in production (buildTaskAgent in chat-agent.ts), closed
  // over the running task's id. Included unconditionally for the same reason
  // as makeCreateTasksTool above: suites/task-plan-progress.yaml needs both
  // actually offered to be meaningful. 'eval-task' is a placeholder id —
  // tool-call/tool-sequence scenarios only inspect response.tool_calls and
  // never execute the tool, so no task with that id needs to exist.
  makeUpdatePlanTool('eval-task'),
  makeCompleteTaskTool('eval-task'),
  // Bound in real task runs only when a previous finished run exists; the
  // eval harness never executes tools, so its store lookups never run here.
  makeReadTaskRunTool('eval-task', 'eval-run'),
  // Bound in production chat and workspace chat (WAKEUP_TOOLS in
  // chat-agent.ts); suites/agent-wait.yaml needs them offered. Never
  // executed here, so no wake-up store or registry is needed.
  scheduleWakeupTool,
  cancelWakeupTool,
  fakeGenerateImageTool,
];

// Builds the system prompt a suite's scenarios are run under: the harness
// prompt (plus any task/workspace context the suite simulates) with the
// ambient-context block spliced on, or undefined when the suite opts out.
//
// Suites can opt into a simulated "AGENT.md" instruction set
// (suite.simulatedUserInstructions — see suites/instruction-hierarchy.yaml)
// to exercise buildSystemPrompt()'s user-instructions branch, which no
// suite exercises by default (bin/eval.ts otherwise always passes no
// argument, harness-only, for reproducibility). Real config/AGENT.md
// content never reaches eval runs — only what's authored directly in
// suite YAML.
//
// suite.appliesHarnessSystemPrompt (default true) lets a suite opt OUT
// entirely — see suites/after-agent.yaml/thread-titles.yaml, whose
// scenarios model a different production code path (after-agent.ts,
// generateTitleHandler) that never attaches this prompt in real usage.
export function buildEvalSystemPrompt(suite: Suite | null | undefined): string | undefined {
  const simulatedTask = suite?.suite.simulatedTask;
  const simulatedWorkspace = suite?.suite.simulatedWorkspace;
  const baseSystemPrompt =
    suite?.suite.appliesHarnessSystemPrompt === false
      ? undefined
      : buildSystemPrompt(
          suite?.suite.simulatedUserInstructions,
          // suite.simulatedTask (see suites/task-plan-progress.yaml) puts
          // the real task-run context block into the prompt, the same way
          // buildTaskAgent() does in production. suite.simulatedWorkspace
          // (see suites/workspace-chat-context.yaml, issue #248) does the
          // same for a workspace-chat turn via buildWorkspaceContextBlock()
          // instead — mutually exclusive with simulatedTask, since those
          // model two different production agent-builder call sites.
          simulatedTask
            ? buildTaskContextBlock({
                title: simulatedTask.title,
                description: simulatedTask.description ?? null,
                outcome: simulatedTask.outcome ?? null,
                plan: simulatedTask.plan ?? null,
              })
            : simulatedWorkspace
              ? buildWorkspaceContextBlock({
                  name: simulatedWorkspace.name,
                  location: simulatedWorkspace.location,
                  goal: simulatedWorkspace.goal ?? null,
                  description: simulatedWorkspace.description ?? null,
                  createdAt:
                    simulatedWorkspace.createdAt ??
                    suite?.suite.simulatedNow ??
                    new Date().toISOString(),
                  systemPrompt: null,
                  wikiDomain: null,
                  latestSummary: null,
                  olderSummaries: simulatedWorkspace.olderSummaries ?? [],
                })
              : undefined,
        );
  // Splices in the same <ambient_context> block ambientContextMiddleware
  // appends on every real model call (api/src/agents/ambient-context.
  // middleware.ts) — bin/eval.ts builds the prompt directly rather than
  // through one of the 5 createAgent() sites that carry that middleware,
  // so without this every eval run was missing it entirely (issue #244's
  // eval gap). Rides the same appliesHarnessSystemPrompt gate: a suite
  // that opts out models a code path that never carries this middleware
  // in production either.
  const systemPrompt =
    baseSystemPrompt === undefined
      ? undefined
      : `${baseSystemPrompt}\n\n<ambient_context>\n${buildAmbientContext({
          timezone: env.timezone,
          now: suite?.suite.simulatedNow ? new Date(suite.suite.simulatedNow) : undefined,
        })}\n</ambient_context>`;
  return systemPrompt;
}
