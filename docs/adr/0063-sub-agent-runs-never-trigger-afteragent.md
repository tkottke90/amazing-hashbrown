# Sub-agent Runs never trigger the AfterAgent pipeline

A Sub-Agent Task's Run is a disposable, single-focus delegation that's meant to return to its
parent as soon as possible (GLOSSARY.md § Sub-Agent Task). The AfterAgent pipeline is built for
the opposite case — a human conversation where nobody thought to save something — and runs extra
background LLM calls (summarize/classify/extract/merge) per completed turn that can bottleneck a
provider the parent thread is waiting on. It's also redundant here: a Sub-Agent Task's own system
prompt already instructs it to call the wiki write tools itself the moment it finds something
worth keeping, which is the one thing AfterAgent's automatic pass would otherwise catch implicitly.

Today, `task-execution.ts` passes `afterAgentEnabled: undefined` into every task-execution run's
context — regular Task and Sub-Agent Task alike — and `undefined` doesn't disable it
(`after-agent.ts`'s own gate only checks for an explicit `false`). So a Sub-Agent Task's Run
already fires AfterAgent today, by default, with nobody having asked for it.

Decided: remove `afterAgentMiddleware` entirely from `buildSubAgentAgent`'s own middleware tuple,
rather than branching the shared context object's `afterAgentEnabled` flag per-origin at its one
call site. The flag defaults to enabled when omitted, which makes a call-site branch fragile: a
future second call site to `buildSubAgentAgent`, or a refactor of that shared context object, could
silently drop the branch and re-enable it with no error and no obviously-failing test. Removing the
middleware from the factory itself makes "no AfterAgent for sub-agents" a property of what kind of
agent this factory builds, not a configuration value someone has to remember to carry forward.

## Considered Options

- Branch `afterAgentEnabled: runTask.origin === 'agent' ? false : undefined` at the shared
  `task-execution.ts` context-construction call site — rejected: `undefined` means enabled, so this
  fails open the moment anyone forgets to carry the branch forward (a second call site, a refactor).
- Add a per-Role config toggle for AfterAgent — rejected: `RoleConfig` only customizes
  provider/model/systemPrompt; there's no plausible Role that would want this on, since
  `buildSubAgentAgent` has exactly one caller and no multi-turn continuation mechanism for the
  rolling-summary/wiki-capture behavior AfterAgent exists to provide.
