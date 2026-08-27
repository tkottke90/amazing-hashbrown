import type { CreateSkillInput } from '@tkottke90/skills-manager';

// Built-in, chat-invoked skills seeded on first boot (see bootSkillsManager
// below) — mirrors wiki.ts's DEFAULT_DOMAINS auto-seed pattern. These skills
// are pure instruction text (per the Skill-Gated Tools pattern in
// AGENTS.md § Composition over Customization): they tell the agent what
// fields to collect and when to call the real create_workspace/
// create_project tools, which do the actual validation and API work.
//
// First tightening, added after a real eval run (suites/create-workspace-
// project.yaml round 1) showed both post-confirmation scenarios failing,
// one per skill, in different but related shapes:
// - cwp-003 (local/gpt-oss:20b): after the user confirmed, the model
//   reasoned it needed a wikiId before calling create_workspace and called
//   wiki_locate instead of the real tool — even though wikiId is optional
//   and the "only ask if the user brings it up" bullet already said not to
//   ask for one by default. The gap was that nothing said what to do once
//   confirmation had already happened: the model treated "find a wikiId"
//   as a reasonable detour rather than recognizing the confirmation step
//   as the last checkpoint.
// - cwp-006 (Lemonade/GLM-4.7-Flash): after the user confirmed with only
//   name/path/winCondition mentioned, the model asked for goal and dueAt
//   before calling create_project, even though both are optional and
//   weren't part of what it had just confirmed.
// Both are the same underlying gap — nothing said the post-confirmation
// call happens immediately, with exactly what was confirmed, no further
// lookups or questions. Added an explicit sentence to each skill's step 4
// naming the specific failure mode (a wiki_locate detour for workspace, an
// optional-field follow-up question for project) since abstract wording
// alone didn't anchor either model away from it.
//
// Second tightening, added after a real eval run against the first
// tightening above (suites/create-workspace-project.yaml round 2):
// - cwp-003 (local) still failed, but the detour changed shape: instead of
//   calling wiki_locate, the model called ask_user to ask the user for a
//   wikiId, reasoning explicitly that "the create_workspace tool expects
//   wikiId field." The first tightening blocked the one specific detour it
//   named (wiki_locate) but never said wikiId is actually optional — the
//   model still believed it was required and just found a different route
//   to get one. Added an explicit "this is genuinely optional, the tool
//   works fine without it" sentence, and widened step 4's carve-out from
//   "don't call wiki_locate" to "don't call wiki_locate, ask_user, or
//   anything else" to close the specific new route this round exposed.
// - cwp-006 (Lemonade) improved from not calling the tool at all to
//   calling it, but with two new problems visible in matchedArgs: it
//   passed name as "ship-homepage-redesign" (a slugified, lowercased
//   directory-style string) instead of the confirmed "Ship Homepage
//   Redesign", and it fabricated a plausible-sounding goal rather than
//   omitting it as the first tightening's wording asked. Likely cause of
//   the name bug: step 3's "the directory name will be derived
//   automatically from the project name" reads, on a careless pass, as if
//   the model itself should supply that derived form as `name`. Added an
//   explicit line that `name` is passed exactly as confirmed — a
//   human-readable title, not a slug — since the tool derives the
//   directory itself; and an explicit "do not invent a plausible value for
//   an omitted optional field" sentence next to the omission rule, since
//   "omit it" alone left room for the model to read "you should still
//   have something to pass" into it.
// cwp-001/cwp-002 also failed for Lemonade this round (previously
// passing), but with reasoningContent addressing steps 2-3, which this
// tightening didn't touch — most likely sampling variance (Lemonade's
// ChatOpenAI construction sets no temperature/seed; see
// api/src/services/provider-factory.ts), not a regression from the first
// tightening. Flagged to verify on the next run rather than assumed.
//
// Third tightening, added after a later eval run (round 4) that verified
// the round-2 flag above: cwp-001 (confirm before creating even when every
// field is already known) failed again, this time for *two* different
// models — Lemonade and Ornith — both calling create_workspace directly
// with no confirmation step at all. Both models' reasoningContent latched
// onto the scenario's own framing sentence ("Collect the workspace fields,
// then call create_workspace") as if it were the user overriding the
// skill's confirmation requirement, rather than a paraphrase of the
// skill's own procedure. Two prior rounds passed this same scenario
// cleanly for both models, so this isn't the same kind of capability
// ceiling as cwp-003 — it's a first-seen, reproducible gap that step 3's
// wording didn't cover: nothing said the confirmation gate still applies
// when the user's own phrasing sounds like a go-ahead, or when every field
// needed is already present. Added a contrastive example to step 3 of both
// skill bodies (mirrored, since both share the same structure and neither
// showed this failure exclusively) naming that exact case explicitly.
//
// Fourth tightening, added after rerunning round 3's fix (round 5 of this
// eval session): the third tightening worked cleanly for local and
// Ornith — both now confirm before creating on cwp-001. Lemonade's cwp-001
// changed shape instead of clearing: rather than skipping confirmation
// outright, it now calls wiki_locate first "to offer wikiId if they want
// one" (visible verbatim in reasoningContent), then never reaches
// ask_user. The wikiId bullet already said not to treat its absence as "a
// blocker to resolve before creating," but that phrasing is abstract and
// only fires at the create step — it doesn't name the concrete tool call
// to avoid, the exact same gap the very first tightening (above) had to
// close for the post-confirmation case. Named wiki_locate explicitly in
// the wikiId bullet itself, matching step 4's already-concrete wording.
// Separately, local's cwp-006 (project, post-confirmation) failed on a new
// axis: it fabricated an unconfirmed goal (already forbidden by the
// second tightening, so likely a one-off variance sample — local's
// ChatOllama construction pins no temperature/seed either) and, more
// consistently fixable, re-capitalized the confirmed winCondition
// ("the new..." became "The new...") when passing it as a tool argument.
// The "pass exactly as confirmed" rule only named `name` explicitly;
// widened it to cover winCondition too, since nothing said a confirmed
// value's casing must survive verbatim into the tool call.
export const DEFAULT_SKILLS: CreateSkillInput[] = [
  {
    name: 'create-workspace',
    description: 'Create a new workspace conversationally, without leaving the chat.',
    body: `Guide the user through creating a workspace, then call the create_workspace tool.

Required field:
- name — the workspace name.

Optional fields:
- goal — what the workspace is for, in a sentence or two.
- wikiId — an existing wiki domain to bind this workspace to. This is genuinely optional — create_workspace works perfectly well with it left out, and there is no requirement to have one. Only ask if the user brings it up; don't ask by default, and don't treat its absence as a blocker to resolve before creating. That means not calling wiki_locate, wiki_orient, or any other tool "to see what domains exist" or "to offer it as an option" — if the user didn't name a wikiId, proceed straight to confirming and creating without one. If they name one themselves, the create_workspace tool validates it against the real wiki domain list itself and will tell you if it doesn't match.
- git — whether to initialize git in the workspace directory. Defaults to no.

Steps:
1. Parse whatever the user already gave you in their message.
2. If "name" is missing, ask for it with a single ask_user call — do not proceed without it. If other optional fields are also missing and worth asking about, batch them into that same question rather than asking one field at a time.
3. Once you have a name (and any other fields the user wants to set), summarize what you're about to create — including that the directory name will be derived automatically from the workspace name — and confirm with a yes/no ask_user call before creating anything. This confirmation step applies even when every field you need is already sitting in the user's message, and even when the message itself describes the process in a way that sounds like a go-ahead — e.g. "/create-workspace called \"Homelab Ops\", goal: track server maintenance" gives you a complete name and goal, but that's still a request to run the skill, not a substitute for asking "create workspace X with goal Y — confirm?" and waiting for a yes. A name and goal being present is exactly the case this step exists for; it is never a reason to skip straight to create_workspace.
4. Only after explicit confirmation, call create_workspace immediately with exactly the fields you already confirmed — the confirmation was the last checkpoint, not a cue to go looking for more. If the user never named a wikiId, that means omit the field entirely; it is not a reason to call wiki_locate, ask_user, or anything else to find or confirm one for them.
5. If the tool reports a conflict (name already in use) or a validation error, relay that message to the user as-is and stop — do not retry with a different name or otherwise route around the rejection. Wait for the user's next instruction.
6. On success, the resource card renders automatically — you don't need to summarize the result yourself beyond a brief confirmation.`,
  },
  {
    name: 'create-project',
    description:
      'Create a new project (a workspace plus a win condition) conversationally, without leaving the chat.',
    body: `Guide the user through creating a project, then call the create_project tool.

Required fields:
- name — the project name.
- winCondition — what "done" looks like for this project.

Optional fields:
- goal — what the project is for, in a sentence or two.
- dueAt — a due date/time, if the user gives one.
- git — whether to initialize git in the project directory. Defaults to no.

Note: unlike workspaces, projects always get a fresh, dedicated wiki automatically — never ask about binding to an existing wiki for a project.

Steps:
1. Parse whatever the user already gave you in their message.
2. If "name" or "winCondition" is missing, ask for both (and any other missing optional fields worth asking about) in a single batched ask_user call — do not ask one field at a time, and do not proceed without both required fields.
3. Once you have the required fields, summarize what you're about to create — including that the directory name will be derived automatically from the project name — and confirm with a yes/no ask_user call before creating anything. This confirmation step applies even when every required field is already sitting in the user's message, and even when the message itself describes the process in a way that sounds like a go-ahead — a complete name and winCondition up front is exactly the case this step exists for, not a reason to skip straight to create_project.
4. Only after explicit confirmation, call create_project immediately with exactly the fields you already confirmed — the confirmation was the last checkpoint, not a cue to go collect more. Pass "name" and "winCondition" exactly as confirmed, character-for-character — same casing, same wording, same punctuation. "Ship Homepage Redesign" stays "Ship Homepage Redesign," never lowercased or hyphenated into a slug (the tool derives the directory name from it internally, so you never construct that form yourself), and a winCondition that starts lowercase in the confirmed text stays lowercase in the tool call — restating it as the start of a new sentence and capitalizing it is still a change, even though it reads naturally that way. Optional fields (goal, dueAt, git) that weren't part of what you confirmed are simply omitted; that is not a reason to ask about them now, and it is not a reason to invent a plausible-sounding value for one either — leave it unset.
5. If the tool reports a conflict (name already in use) or a validation error, relay that message to the user as-is and stop — do not retry with a different name or otherwise route around the rejection. Wait for the user's next instruction.
6. On success, the resource card renders automatically — you don't need to summarize the result yourself beyond a brief confirmation.`,
  },
];
