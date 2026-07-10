# Autonomous Collaboration Architecture

**Date:** 2026-07-10
**Status:** Draft
**Related:** [`docs/system-flows.html`](../system-flows.html) (thread type flows)

## Purpose

Define the architectural principles and system components that allow this agent to work
autonomously on the user's behalf — not just respond when spoken to. This document captures
the synthesis of five interlocking concepts and describes the four systems required to
implement them.

---

## Background: The Chat-Only Problem

A pure chat interface is a capable tool but an incomplete agent. Every action it takes is
initiated by the user, which means the user must be present, must remember to ask, and must
wait for a response before anything happens. That model trades away the most compelling
property of an autonomous agent: the ability to work independently.

The goal of this project is not a chat assistant. It is an agent that can be trusted to
work without constant oversight, surface the right information at the right time, and pull
the user in only when their judgment is genuinely needed. Chat is one mode of interaction
with that agent — not the definition of it.

This requires answering five distinct questions:

- **When** does work start if the user didn't initiate it?
- **How** does work proceed when the user isn't watching?
- **Where** is work at any moment — what is in flight, what is waiting, what is done?
- **What** does the user need to know, and how urgently?
- **How** does the user stay oriented without being interrupted?

Each question maps to one of the five concepts described below.

---

## The Five Concepts

### 1. Non-Chat Triggers

Work that only starts when a human sends a message is not autonomous. Triggers are the
mechanism by which the system can initiate work without direct human input.

Five trigger types cover the full space:

| Type | Description | Example |
|---|---|---|
| **Interval** | Recurring on a schedule | Process inbox every morning at 7am |
| **Scheduled** | One-shot at a specific date/time | Send briefing at start of next quarter |
| **Duration / Delay** | A task has been waiting or running for too long | Escalate if no response within 4 hours |
| **Event** | An external signal arrives | An alert fires; a webhook is received |
| **Agent Self-Schedule** | The agent pauses its own task and schedules a future wakeup | "Tests are running; check back in 10 minutes" |

The fifth type — agent self-scheduling — deserves special emphasis because it is the one
most often missing from autonomous systems, and its absence causes characteristic failure
modes: agents that spin in a wait loop consuming resources, agents that time out and fail
when the underlying work simply needed more time, and agents that hold a task open blocking
other work from proceeding.

The pattern is: the agent recognizes that it cannot make progress right now (a build is
running, an external API is rate-limited, a long test suite is executing, a deployment is
propagating) and actively decides to put the task down rather than wait. It records enough
resumption context to continue meaningfully when it wakes up, marks the task as `blocked`
in the task system, and releases. A scheduled trigger fires at the agent-specified time and
resumes the task from where it left off.

This is borrowed directly from Kanban's `blocked` card state. A blocked card is not failed
or cancelled — it is parked with a reason and a resolution condition. The key insight is
that **blocking is a first-class outcome of working**, not an error state. Treating it as
such makes the system more resilient and allows the agent to be genuinely productive across
multiple tasks rather than holding resources open while waiting.

Without triggers, the system has no agentic capability — it is purely reactive to human
input. Triggers are what transform it from a tool into a collaborator.

Triggers always resolve to a task: they create a unit of work in the task system with a
defined goal and authority level, then let the agent execute that task according to
Commander's Intent (see below).

---

### 2. Commander's Intent

Named after the military planning concept: rather than issuing exhaustive orders, commanders
brief on the *why* and *desired end state* so that subordinates can make sound decisions
when situations change and communication is unavailable.

Applied here: an agent given only instructions will stall or fail the moment reality
diverges from the plan. An agent given the goal, the context, and the boundaries of its
authority can navigate unexpected situations, make reasonable decisions, and reserve
escalation for things that genuinely require human judgment.

When a task is defined, it should capture:

- **Outcome**: what does "done" look like?
- **Authority level**: what decisions can the agent make autonomously vs. what must it ask?
- **Constraints**: what should it never do without explicit permission?
- **Escalation conditions**: what situations should always surface to the user regardless of
  authority level?

This is the execution layer. It determines how far the agent goes before pausing and what
it does when it encounters something it wasn't expecting.

---

### 3. Kanban's Visibility Principle

Inspired by Kanban: tasks have explicit stages, the progression through those stages is
visible to the user, and work-in-progress is capped to prevent the system from spiraling
out of control.

The critical property is not the specific stages but that **the current state of every
task is always knowable**. The user should never have to wonder what the agent is doing.

Key elements:

- **Task stages**: a defined state machine (e.g. `pending → running → waiting_on_user →
  done | failed | cancelled`); `running` can also transition to `blocked` when the agent
  self-schedules a wakeup, then back to `running` when the trigger fires — blocked is not
  failure, it is a deliberate park
- **WIP limits**: bounds on how many tasks can be in each stage simultaneously to prevent
  resource exhaustion and cognitive overload
- **Passive and active participation**: the user can watch the board update without acting
  (passive) or reach in to redirect, reprioritize, or cancel a task (active); the system
  supports both without requiring either

This is the coordination layer. It is shared workspace — the user and the agent have the
same view of what is in flight.

---

### 4. The Escalation Spectrum

Not all communication from the agent to the user carries the same urgency or requires the
same response. Treating every notification as an interrupt (or suppressing everything) are
both failures. The escalation spectrum defines four tiers:

| Tier | Description | Delivery | User action |
|---|---|---|---|
| **Inform** | Here is what happened | Dashboard widget / digest | None required |
| **Confirm** | I acted — let me know if that was wrong | Soft notification; undo window | Optional correction |
| **Decide** | I am blocked and cannot continue without input | Active HITL prompt | Required before agent proceeds |
| **Escalate** | Something unexpected happened that needs immediate attention | Interrupt / push notification | Required promptly |

The agent chooses the tier based on the reversibility of the action, the cost of being
wrong, and whether the task can proceed without input. The tier determines the delivery
channel and the urgency.

Most task completions are Inform. The existing HITL system covers Decide. Confirm and
Escalate are the gaps in the current design.

The escalation spectrum also has a **scheduling dimension**: the user is not always
available, and different tiers warrant different interruption policies. A Decide prompt can
wait until the user is free; an Escalate notification may need to reach them immediately
regardless of time.

---

### 5. Monitoring and Dashboards

This is the ambient awareness layer — how the user stays oriented without being
interrupted.

Traditional dashboards fail because they require someone to decide upfront what to measure,
how to visualize it, and what it means. The result is dashboards that surface numbers
without interpretation. An agent that is already doing the work has the context to generate
its own reporting — not just data, but meaning.

The key insight: **a well-designed dashboard widget is the Inform tier rendered as a
persistent, queryable artifact rather than a one-time notification.**

Agents publish widgets as a byproduct of their work. A widget is an isolated, self-contained
unit: a question the agent knows how to answer, updated as the underlying data changes.
Examples:

- "Your inbox has been quiet on Project X for 3 days — unusual given last week's pace"
- "Wiki knowledge base: 47 pages, last updated 2 hours ago, 2 lint warnings"
- "3 tasks completed overnight, 1 waiting for your input"

This avoids disrupting the user while still delivering value. The user consumes dashboard
content on their own schedule; the agent publishes it as a side effect of working.

This also means agents define the dashboard, not the user. The agent understands what it
is doing well enough to know what is worth communicating.

---

## The Synthesis

These five concepts are not independent features — they are layers of a single system, each
required for the others to function correctly:

```
Triggers         →  initiate work without human input
Commander's Intent →  execute work without constant oversight
Kanban Visibility  →  make the state of work shared and legible
Escalation Spectrum → communicate back at the right level and urgency
Dashboards         →  maintain ambient awareness without interruption
```

Remove any one layer and the system degrades in a specific way:

- No triggers → chat assistant only; no autonomous capability
- No Commander's Intent → agent stalls on every unexpected event
- No Kanban → neither party knows what is in flight; coordination breaks down
- No Escalation Spectrum → everything either interrupts or disappears silently
- No Dashboards → user has no ambient awareness; must actively check to stay informed

### The Elastic Participation Model

The deeper principle that unifies all five is that **the user's level of involvement should
be elastic, not fixed**.

Most automation systems force a binary: in the loop (slow, high friction) or out of it
(fast, black box). This architecture allows the user to exist anywhere on a spectrum at any
moment:

| Engagement level | What the user is doing | What supports it |
|---|---|---|
| **Fully passive** | Living their life | Dashboards accumulate; no interruptions |
| **Ambient awareness** | Glancing at state occasionally | Kanban board; dashboard widgets |
| **Selective engagement** | Acting on specific items | Confirm/Decide notifications |
| **Active direction** | Redirecting or reprioritizing work | Kanban controls; task editing |
| **Full collaboration** | Working together in real time | Chat interface |

The agent's job is to work at the highest autonomy level the situation allows and pull the
user to a higher engagement level only when necessary. Commander's Intent determines when
that transition is needed. The Escalation Spectrum determines how it happens.

### The Human-Methodology Parallel

The collaboration model maps naturally onto patterns developed for human teams:

- **Triggers** correspond to on-call systems and event-driven workflows
- **Commander's Intent** is delegation: outcome + authority + escalation conditions
- **Kanban Visibility** is shared workspace: the board is the source of truth for both parties
- **Escalation Spectrum** maps to async communication norms: batch questions, signal
  urgency explicitly, provide enough context that the recipient doesn't need to ask follow-up
- **Dashboards** correspond to what management reporting always tried to be — interpretation,
  not just data

The methodologies that work best for human async collaboration (Kanban, async-first team
norms, delegation practices) work because they make the state of work visible and define
clean handoff moments between parties. The same principle applies here.

---

## Implications for This Project

This architecture defines four systems that need to be built, layered on top of the existing
chat and automated task execution:

### Task System
A persistent model of every unit of work — its type, its goal, its authority level, its
current stage, its history. The Kanban board is a view over this. The escalation system
reads from it. The trigger system writes to it. Everything else depends on it.

### Trigger System
The mechanism by which work starts without human initiation. Manages the four trigger types
(interval, scheduled, duration, event), resolves each to a task in the task system, and
handles lifecycle (enable, disable, one-shot vs. recurring).

### Escalation System
Determines which tier of the escalation spectrum applies to a given situation and routes
the communication accordingly. Needs to model user availability and preferences alongside
task urgency. The existing HITL mechanism is a primitive implementation of the Decide tier;
this system wraps and extends it.

### Dashboard System
A runtime for agent-published widgets. Agents emit widget definitions as a byproduct of
working; the system renders them in the UI and refreshes them as data changes. The user
sees an always-current view of what the agents know, without being asked to actively query.

---

## Open Questions

- What is the right storage model for tasks? In-memory is insufficient; SQLite (already
  under consideration for conversation memory) is a natural fit.
- How does user availability get modeled? Calendar integration, manual schedule, or
  inferred from activity patterns?
- What is the widget definition format? JSON schema that agents emit? A more structured
  DSL?
- Should the dashboard be a separate UI surface or integrated into the existing thread/task
  view?
- How do triggers interact with the authority model — does each trigger type carry implicit
  authority, or is it always explicit in the task definition?
