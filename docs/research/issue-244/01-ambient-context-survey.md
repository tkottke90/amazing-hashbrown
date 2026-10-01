# Research: Ambient Context Mature LLM Agent Harnesses Inject Into System Prompts

Research for [issue #244](https://github.com/tkottke90/amazing-hashbrown/issues/244).

## 1. Overview of the Question

`buildSystemPrompt()` (`api/src/agents/system-prompt.ts`) currently gives the
chat agent no information about its own situation — no current date/time, no
timezone, no notion of what machine or session it's running in. This was
surfaced concretely during eval work: asked to "schedule it for tomorrow at
3pm," the model had no way to resolve "tomorrow" without burning a
`shell_exec` tool call just to read the system clock.

The question this doc answers: **what ambient-context categories do mature,
real-world LLM agent harnesses actually inject into their system prompts,
beyond the conversation itself — and what's the evidence for each, traced to
a primary source rather than a blog post repeating a claim?** The goal is
input to a design discussion, not a recommendation — each finding below
states what was found, where, and why (per the source) it's there, so the
team can decide which categories are worth adopting here.

A primary source, per the task brief, means: official vendor documentation,
actual open-source code, a vendor-confirmed/officially-published prompt, or a
first-party API/SDK doc. Where only a secondary source (blog, aggregator)
could be found, that's called out explicitly rather than presented as
sourced fact.

## 2. Information Found

### 2.1 Current date/time, and timezone handling specifically

**Anthropic — claude.ai / mobile app system prompts (officially published).**
Anthropic publishes the literal system prompt text used by claude.ai and the
iOS/Android apps at
[platform.claude.com/docs/en/release-notes/system-prompts](https://platform.claude.com/docs/en/release-notes/system-prompts)
(redirects from the older `docs.anthropic.com` path). The overview page
states directly:

> "Claude's web interface (claude.ai) and mobile apps use a system prompt to
> provide up-to-date information, such as the current date, to Claude at the
> start of every conversation... These system prompt updates do not apply to
> the Claude API."

The current Claude Sonnet 5 prompt (dated June 30, 2026, at
[.../system-prompts/claude-sonnet-5](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-sonnet-5))
shows the actual mechanism: a `{{currentDateTime}}` template variable, used
not as a bare fact but to calibrate the model's own knowledge-cutoff framing:

> "It answers the way a highly informed individual in Jan 2026 would if
> talking to someone from `{{currentDateTime}}`, and can say so when
> relevant."

Rationale (stated): keep the model's sense of "now" accurate without
retraining, and let it reason correctly about how stale its own training
data is relative to the live conversation. Caveat (also explicitly stated by
Anthropic): **this is scoped to claude.ai/the apps and explicitly does not
apply to the Claude API** — an API-based harness like this repo gets none of
this by default and must inject it itself.

**OpenAI — Harmony response format (official cookbook) and the Model Spec.**
OpenAI's own cookbook article on the Harmony format
([developers.openai.com/cookbook/articles/openai-harmony](https://developers.openai.com/cookbook/articles/openai-harmony))
gives the canonical system-message shape used by its open-weight gpt-oss
models:

```
<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: 2025-06-28
...
```

The mechanism behind the literal date is visible in the actual chat template
shipped with the model weights — `chat_template.jinja` in the
[openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b/blob/main/chat_template.jinja)
model repo on Hugging Face — which computes it at render time rather than
hardcoding it:

```jinja
{{- "Current date: " + strftime_now("%Y-%m-%d") + "\n\n" }}
```

This is the same "Knowledge cutoff / Current date" pairing widely reported
for OpenAI's hosted ChatGPT models, but for the hosted product specifically
only the gpt-oss template (open-weight, inspectable) was verifiable as a
primary source here — the hosted ChatGPT system message is not published by
OpenAI the way Anthropic publishes claude.ai's, so that specific pairing for
the hosted product should be treated as plausible-but-not-vendor-confirmed
pending a more direct citation.

**Aider — real open-source code (not a leak).**
Aider's actual source
([`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py),
`get_platform_info()`) builds the date line itself:

```python
dt = datetime.now().astimezone().strftime("%Y-%m-%d")
platform_text += f"- Current date: {dt}\n"
```

This directly answers the timezone sub-question: Aider resolves "today" via
Python's `datetime.now().astimezone()` called with **no explicit timezone
argument**, which resolves to the **host machine's local timezone** (via the
OS's configured zone) — not UTC, and not a user-specified/profile timezone.
In other words, the one real open-source harness checked here punts the
"which timezone is 'today' in" problem entirely to whatever timezone the
process's host OS happens to be set to. No comment in the source gives an
explicit rationale beyond that it's folded into the same `get_platform_info()`
block as platform/shell/language — treated as one fact among several about
the user's local environment.

**Known failure mode (OpenAI developer community, informative but not a
vendor doc — flagged as secondary).** A thread on OpenAI's developer forum
(["TO OPENAI: You must STOP injecting a system message..."](https://community.openai.com/t/to-openai-you-must-stop-injecting-a-system-message-to-api-gpt-5-that-is-counter-to-developer-applications/1348819))
and independent write-ups describe the UTC-vs-local mismatch this causes in
practice: if a harness computes "today" in UTC while the user is, say, in US
Mountain time in the evening, a scheduling request can resolve to the wrong
calendar day. This is a secondary source (forum post / blog), not a vendor
doc, but it's cited here only to characterize the _failure mode_, not to make
a vendor claim — and it is exactly the class of bug a bare `Date.now()` in
UTC would reproduce in this repo.

**Bottom line on timezone:** none of the primary sources found actually
solve "resolve 'today' to the _user's_ timezone" in a principled way — Aider
punts to host-local, Anthropic's claude.ai prompt doesn't document its own
timezone resolution (only that a date/time value is injected), and OpenAI's
gpt-oss template just stamps a date with no timezone context at all. This
looks like a genuinely unsolved/under-specified problem across the harnesses
surveyed, worth flagging as a design decision this repo has to make
deliberately rather than copy.

### 2.2 OS / platform

**Aider (real source, same `get_platform_info()`):**

```python
platform_text = f"- Platform: {platform.platform()}\n"
```

using Python's standard `platform.platform()` call, with an explicit
fallback (`"Platform information unavailable"`) if it raises. This sits
alongside shell detection:

```python
shell_var = "COMSPEC" if os.name == "nt" else "SHELL"
shell_val = os.getenv(shell_var)
platform_text += f"- Shell: {shell_var}={shell_val}\n"
```

Rationale (inferable from what's adjacent in the same block): the model is
expected to propose shell commands to the user, and a command that's valid
on the user's actual OS/shell combination (e.g. not suggesting `ls` to a
`cmd.exe`/Windows user) is the explicit purpose — this block directly feeds
`shell_cmd_prompt`/`shell_cmd_reminder` templates elsewhere in the same file.

**Claude Code CLI — unverified leak, flagged explicitly.** Independent
reverse-engineering writeups (a
[GitHub gist](https://gist.github.com/agokrani/919b536246dd272a55157c21d46eda14)
reproducing a captured Claude Code session, and the community-maintained
[Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
repo, which tracks the prompt release-over-release) show an environment
block of this shape:

```
Working directory: /Users/agokrani/Documents/git/sb-custom-blocks
Is directory a git repo: Yes
Platform: darwin
OS Version: Darwin 24.5.0
Today's date: 2025-08-18
Model: claude-sonnet-4-20250514
```

**Important caveat:** unlike the claude.ai web/app system prompt (which
Anthropic officially publishes — see 2.1 and 2.5), **Anthropic does not
publish the Claude Code CLI's internal system prompt.** The CLI's source
reportedly leaked in early 2026 (reported by
[Cybernews](https://cybernews.com/tech/claude-code-leak-spawns-fastest-github-repo/)
and corroborated by multiple independent decompiled-source repos), and
Anthropic has issued takedown notices against mirrors of it. This block
should therefore be read as **a plausible, widely-corroborated-but-vendor-
unconfirmed reconstruction**, not an official Anthropic-published fact, in
contrast to the claude.ai prompt in 2.1/2.5 which _is_ vendor-confirmed.
It's included here because the shape (cwd, git-repo flag, platform, OS
version, date, model) is a well-documented _convention_ even if this
specific instance's provenance is a leak rather than a publication.

### 2.3 Working directory / environment

Same two sources as 2.2 carry this:

- **Aider** (real source) folds "is this a git repo," the user's configured
  lint command(s), and test command into the same `get_platform_info()`
  block (see the code quoted in 2.2), explicitly so the model doesn't
  re-suggest commands the user already told it to run automatically:
  > "The user's pre-commit runs these lint commands, don't suggest running
  > them" vs. "The user prefers these lint commands:" (the wording branches
  > on `self.auto_lint`).
- **Claude Code CLI** (unverified leak, see 2.2's caveat) reportedly includes
  `Working directory: <path>` and `Is directory a git repo: Yes/No` in the
  same environment block.

Rationale in both cases is the same: a coding agent's tool calls (shell
commands, file paths) are only correct relative to a specific cwd, so the
model needs to be told it rather than assuming one.

### 2.4 Session or conversation identifiers

**LangGraph (official docs — directly relevant since this repo already uses
LangChain/LangGraph).**
[docs.langchain.com/oss/python/langgraph/checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)
defines a thread as:

> "A thread is a unique ID or thread identifier assigned to each checkpoint
> saved by a checkpointer." ... "the checkpointer uses `thread_id` as the
> primary key for storing and retrieving checkpoints." ... "Without it, the
> checkpointer cannot save state or resume execution after an interrupt."

This is **not** framed as something injected into the model's own context —
it's a persistence/addressing key the _harness_ uses to load the right
history before building the prompt, not ambient text the model is told about
directly. Worth noting precisely because it's a different kind of "ambient
context" than the others in this survey: infrastructure-level, not
prompt-level.

**OpenAI Conversations API (official docs).**
[developers.openai.com/api/docs/guides/conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)
describes the same pattern on OpenAI's side: a conversation object
"persist[s] conversation state as a long-running object with its own durable
identifier," so a `conversation_id` (or `previous_response_id` for simple
chaining) can be passed on each call "so you don't have to pass inputs
manually with each turn." Same conclusion: this is a request-plumbing
identifier used by the calling code, not a fact stated to the model inside
its own system prompt.

**Relevance to this repo:** `amazing-hashbrown` already has an analogous
identifier — `task_queue.thread_id` for task runs (per `api/AGENTS.md`'s
"Automated task runs" section) — used the same way: to address which
history/state a turn continues, not as text injected into the prompt itself.
No primary source surveyed here injects a raw session/thread ID _into the
model's own visible context_ as ambient metadata; it's uniformly an
addressing mechanism the application layer uses, which argues against
treating "session identifier" as a system-prompt-injection candidate the way
date/platform are.

### 2.5 Model identity (the model telling itself which model it is)

**Anthropic — claude.ai system prompt (officially published, same source as
2.1).** The published Claude Sonnet 5 prompt states plainly:

> "This iteration of Claude is Claude Sonnet 5."

and, notably, explains _why_ this needs to be stated explicitly rather than
assumed from training:

> "The person can switch models mid-conversation, so earlier messages in
> this thread that identify as a different model or report a different
> knowledge cutoff may still be accurate."

That's a concrete, vendor-stated rationale: in a product where the
underlying model can change mid-thread, the model cannot infer its own
identity from the conversation history, so the harness has to tell it
explicitly, every turn.

**OpenAI — Harmony cookbook (official, same source as 2.1).** The canonical
system message opens with the same convention:

> "You are ChatGPT, a large language model trained by OpenAI."

**Claude Code CLI environment block (unverified leak, see 2.2's caveat)**
reportedly includes a literal `Model: claude-sonnet-4-20250514` line — i.e.
the harness stamps the exact model ID/version string being used for _that_
call, distinct from the "Claude Sonnet 5" product-name framing in the
claude.ai prompt. This is a useful distinction to carry into any design
discussion: "which product/persona am I" (claude.ai's framing) vs. "which
exact model string is serving this request" (Claude Code's reported
framing) are two different things a harness might want to state.

### 2.6 Locale

**Aider (real source, `get_user_language()` in `base_coder.py`):** a
three-tier fallback —

```python
# 1. Explicit override
if self.chat_language:
    return self.normalize_language(self.chat_language)
# 2. System locale
lang = locale.getlocale()[0]
# 3. Environment variables, in order
for env_var in ("LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES"):
    ...
```

normalizing whatever it finds (e.g. `en_US` → `English`) and feeding it
straight into an instruction: `final_reminders.append(f"Reply in
{user_lang}.\n")`. This is the clearest primary-source example found of
locale as ambient context with an explicit, stated purpose (control the
_reply language_, not just a cosmetic fact) rather than a vague "nice to
know."

No other primary source surveyed documents locale injection as clearly as
Aider's does. The "Accept-Language header → system prompt" pattern described
in some tooling blog posts/PRs found during this search (e.g. a
language-injection skill referencing `get_language_instruction()`) could not
be traced to an official vendor doc or a widely-recognized harness's own
repository, so it is **not** reported here as sourced — only Aider's is.

### 2.7 Other well-documented conventions found

- **Lint/test command conventions (Aider, real source).** Beyond pure
  "ambient facts," Aider's `get_platform_info()` block also injects
  user-configured operational commands (lint/test commands, and whether
  they already run automatically via pre-commit) so the model doesn't
  propose redundant commands. This is less "ambient context about the
  world" and more "ambient context about how this particular user/repo
  wants to be worked with" — a different category worth distinguishing from
  pure OS/date facts if this repo adopts something similar (it already has
  an analog: `workspaceContext` passed into `buildSystemPrompt()`).
- **Anthropic's `<anthropic_reminders>` mechanism (officially published,
  same source as 2.1/2.5).** The claude.ai prompt documents a convention of
  injecting conditional, event-triggered reminders _mid-conversation_
  (`long_conversation_reminder`, `cyber_warning`, etc.) rather than only at
  conversation start — i.e., ambient context doesn't have to be a single
  static block built once; it can be refreshed/re-injected by the harness
  when a specific condition fires later in the same thread. That's a
  structurally different idea from "inject once at system-prompt-build
  time" and may be relevant if this repo ever wants to refresh date/time for
  very long-running threads.
- **IDE/editor state (Cursor) — could not verify as primary.** Several
  blog posts describe Cursor's agent prompt as including "IDE state
  including current cursor position, open file, terminal CWD." Cursor's own
  official documentation page
  ([cursor.com/docs/agent/prompting](https://cursor.com/docs/agent/prompting))
  was checked directly and does **not** describe this — it only discusses
  the context window filling up with files/tools/messages the user adds.
  This category is reported here explicitly as **unverified against a
  primary source** and should not be treated as confirmed.

## 3. References

- Anthropic — official claude.ai/app system prompt release notes (overview):
  https://platform.claude.com/docs/en/release-notes/system-prompts
- Anthropic — Claude Sonnet 5 system prompt text (`{{currentDateTime}}`,
  model-identity framing, `<anthropic_reminders>`):
  https://platform.claude.com/docs/en/release-notes/system-prompts/claude-sonnet-5
- OpenAI — Harmony response format cookbook (official; "Knowledge
  cutoff"/"Current date" system-message shape, "You are ChatGPT..."):
  https://developers.openai.com/cookbook/articles/openai-harmony
- OpenAI gpt-oss-20b chat template (official model repo; `strftime_now`
  date computation): https://huggingface.co/openai/gpt-oss-20b/blob/main/chat_template.jinja
- OpenAI Model Spec (checked directly; does not document date/identity
  injection mechanics — noted as a gap): https://model-spec.openai.com/2025-12-18.html
- OpenAI — Conversations API / conversation-state guide (official):
  https://developers.openai.com/api/docs/guides/conversation-state
- Aider source — `get_platform_info()`, `get_user_language()`,
  `fmt_system_prompt()` (real open-source code, not a leak):
  https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py
- LangGraph — checkpointers / `thread_id` docs (official; directly relevant,
  this repo already uses LangChain/LangGraph):
  https://docs.langchain.com/oss/python/langgraph/checkpointers
- Cursor — official agent prompting docs (checked directly; does not
  confirm the IDE-state claim): https://cursor.com/docs/agent/prompting
- Claude Code CLI environment-block reconstruction — **unverified leak,
  not vendor-confirmed**, included only as a widely-corroborated convention:
  - Gist (captured session): https://gist.github.com/agokrani/919b536246dd272a55157c21d46eda14
  - Community-maintained prompt archive: https://github.com/Piebald-AI/claude-code-system-prompts
  - Leak reporting: https://cybernews.com/tech/claude-code-leak-spawns-fastest-github-repo/
- Secondary source, cited only to characterize a failure mode, not as a
  vendor claim (UTC-vs-local-timezone date mismatch):
  https://community.openai.com/t/to-openai-you-must-stop-injecting-a-system-message-to-api-gpt-5-that-is-counter-to-developer-applications/1348819

## Caveat

Two categories surveyed turned out to have **no solid primary source**
either way, and that absence is itself a finding:

1. **Timezone resolution.** Every primary source that injects a date either
   doesn't document how it resolves to a timezone (Anthropic's `claude.ai`
   prompt) or resolves to the _host machine's_ local timezone with no
   attempt to use the _user's_ timezone (Aider's `datetime.now().astimezone()`
   with no explicit zone, OpenAI's `strftime_now` with no zone argument
   shown in the template). None of the harnesses surveyed demonstrate a
   principled "resolve to the user's own timezone" pattern — this looks
   like a real design decision for this repo to make rather than something
   to copy from precedent.
2. **Session/conversation identifiers as prompt content.** Both LangGraph's
   `thread_id` and OpenAI's `conversation_id` are addressing keys the
   calling application uses to load/save state — neither source shows the
   identifier itself being written into the model's visible context as
   ambient text. If this repo considers surfacing a thread/session id to
   the model (as opposed to just using it to load history), that would be a
   departure from precedent, not a continuation of it.

Also note the recurring methodological point from the task brief: the
Claude Code CLI environment block (2.2, 2.3, 2.5) is the single most
commonly cited example of this whole pattern across the web, but it is a
**leak**, not an Anthropic publication — unlike the claude.ai web prompt,
which Anthropic does officially publish and which independently confirms
the same underlying idea (inject current date, inject model identity) for
a different Anthropic product. The convention should be weighed on the
strength of the claude.ai + Aider + OpenAI evidence, not on the leaked CLI
prompt's popularity alone.
