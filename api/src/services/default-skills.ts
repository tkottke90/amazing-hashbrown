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
//
// Fifth tightening, added after a fresh eval run
// (eval-logs/auto-eval-20260928140346.yaml round 1) against all four
// configured providers, including a newly-added one (Digital Ocean/
// glm-5.3-flash) never tested against this suite before:
// - cwp-008 (local): after confirmation named only name/newWikiName (no
//   goal), the model still called ask_user to request a goal before
//   create_workspace, reasoning from the create_workspace tool's own
//   description ("after all required fields have been collected and
//   confirmed") that goal was something it still needed to collect. The
//   create-project skill's step 4 already has an explicit "optional
//   fields not confirmed are simply omitted, don't ask" sentence (added
//   in the second tightening above) — create-workspace's step 4 never
//   got the equivalent. Added it here, mirroring create-project's wording
//   for goal/wikiId/newWikiName/git.
// - cwp-008 (Digital Ocean): passed create_workspace with name:
//   "image-archive" and newWikiName: "image-archive-notes" — slugified,
//   lowercased forms of the confirmed "Image Archive"/"Image Archive
//   Notes". create-project's step 4 already has an explicit
//   character-for-character/no-slug rule for name (added in the second
//   tightening above); create-workspace's step 4 never got it either.
//   Added the same rule here, extended to also cover newWikiName since
//   workspace has no winCondition field to anchor it to.
// - Both tool descriptions (create_workspace, create_project — see
//   create-workspace.tool.ts / create-project.tool.ts) read "after all
//   required fields have been collected and confirmed with the user."
//   local's reasoningContent quoted this phrase near-verbatim as its
//   justification for treating goal as something still to collect — the
//   word "collected" reads as an instruction to gather more, even though
//   the skill body it's paired with already lists goal as optional and
//   already-decided-or-omitted by this point. Reworded both tool
//   descriptions to "after the required fields have been confirmed with
//   the user" — dropping "collected" removes the phrase the model was
//   latching onto without changing what the tool actually requires.
// - cwp-002 (Lemonade): asked for the missing workspace name using
//   kind: "multiple_choice" with four fabricated example names ("Homelab
//   Ops", "Project Documentation", ...) instead of kind: "free_text" —
//   a name has no fixed set of valid values, so offering choices means
//   presenting invented placeholder answers as if they were real options.
//   Step 2 never said which `kind` to use for an open-ended field like
//   name; added an explicit "use free_text, not multiple_choice" note to
//   both skills' step 2 (create-project's equivalent ask for
//   name/winCondition has the same shape, so mirrored there too even
//   though it wasn't observed failing this round).
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
- newWikiName — use instead of wikiId only when the user asks for a new or dedicated wiki for this workspace: create_workspace creates it and binds it in one step. If they don't give it a name, use the workspace name. Same rule as wikiId: never ask about it or suggest it unprompted, and never pass both.
- git — whether to initialize git in the workspace directory. Defaults to no.

Steps:
1. Parse whatever the user already gave you in their message.
2. If "name" is missing, ask for it with a single ask_user call using kind: "free_text" — do not proceed without it, and do not use kind: "multiple_choice" with invented example names, since there is no fixed set of valid names to choose from. If other optional fields are also missing and worth asking about, batch them into that same question rather than asking one field at a time.
3. Once you have a name (and any other fields the user wants to set), summarize what you're about to create — including that the directory name will be derived automatically from the workspace name — and confirm with a yes/no ask_user call before creating anything. This confirmation step applies even when every field you need is already sitting in the user's message, and even when the message itself describes the process in a way that sounds like a go-ahead — e.g. "/create-workspace called "Homelab Ops", goal: track server maintenance" gives you a complete name and goal, but that's still a request to run the skill, not a substitute for asking "create workspace X with goal Y — confirm?" and waiting for a yes. A name and goal being present is exactly the case this step exists for; it is never a reason to skip straight to create_workspace.
4. Only after explicit confirmation, call create_workspace immediately with exactly the fields you already confirmed — the confirmation was the last checkpoint, not a cue to go looking for more. Pass "name" and "newWikiName" exactly as confirmed, character-for-character — same casing, same wording, same punctuation, for any name at all, not just an example that happens to match one you've seen before: "Image Archive" stays "Image Archive," "Homelab Ops" stays "Homelab Ops," never lowercased or hyphenated into a slug (the tool derives the directory name from it internally, so you never construct that form yourself). Every optional field — goal, git, wikiId, newWikiName, remoteUrl, all of them, not just the ones named explicitly here — follows the same rule: if it wasn't part of what you confirmed in step 3, simply omit it from the tool call. That is never a reason to ask about it now (via ask_user or any other tool), never a reason to invent a plausible-sounding value for it, and never a reason to go looking for one (e.g. calling wiki_locate, wiki_orient, or anything else to find a wikiId). The tool's own description says fields must be "confirmed," not that every optional field must be populated; confirmation already happened in step 3, and whatever wasn't in it stays unset — full stop, no exceptions for any particular field name.
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
2. If "name" or "winCondition" is missing, ask for both (and any other missing optional fields worth asking about) in a single batched ask_user call using kind: "free_text" — do not use kind: "multiple_choice" with invented example values, since neither field has a fixed set of valid answers. Do not ask one field at a time, and do not proceed without both required fields.
3. Once you have the required fields, summarize what you're about to create — including that the directory name will be derived automatically from the project name — and confirm with a yes/no ask_user call before creating anything. This confirmation step applies even when every required field is already sitting in the user's message, and even when the message itself describes the process in a way that sounds like a go-ahead — a complete name and winCondition up front is exactly the case this step exists for, not a reason to skip straight to create_project.
4. Only after explicit confirmation, call create_project immediately with exactly the fields you already confirmed — the confirmation was the last checkpoint, not a cue to go collect more. Pass "name" and "winCondition" exactly as confirmed, character-for-character — same casing, same wording, same punctuation. "Ship Homepage Redesign" stays "Ship Homepage Redesign," never lowercased or hyphenated into a slug (the tool derives the directory name from it internally, so you never construct that form yourself), and a winCondition that starts lowercase in the confirmed text stays lowercase in the tool call — restating it as the start of a new sentence and capitalizing it is still a change, even though it reads naturally that way. Optional fields (goal, dueAt, git) that weren't part of what you confirmed are simply omitted; that is not a reason to ask about them now, and it is not a reason to invent a plausible-sounding value for one either — leave it unset.
5. If the tool reports a conflict (name already in use) or a validation error, relay that message to the user as-is and stop — do not retry with a different name or otherwise route around the rejection. Wait for the user's next instruction.
6. On success, the resource card renders automatically — you don't need to summarize the result yourself beyond a brief confirmation.`,
  },
  // Tightening, added after a real eval run (suites/file-conflict-
  // resolution.yaml round 3, 2026-10-12) found Lemonade and Ornith both
  // failing fcr-001 the same way: the draft and on-disk versions each
  // changed the same bullet-line position with a different, unrelated
  // fact (draft: a new "deployment steps" note; on-disk: a "license year"
  // note), and both models read step 2's "same region" language literally
  // as a same-line conflict, then dropped one side per the prefer-draft
  // rule — one model dropped the on-disk line, the other dropped the
  // draft's. The scenario's own purpose states the intent plainly: prove
  // a real merge, not a one-sided pick of either side. Round 1 of the
  // same suite also surfaced a harness bug (propose_file_merge was never
  // added to bin/eval-setup.ts's evalTools, so no provider had the tool
  // bound at all) — fixed separately in that file, unrelated to this
  // wording gap. Added an explicit worked-example pair distinguishing a
  // true same-field conflict (same JSON key, incompatible values) from
  // two edits that only collide on line position but state compatible,
  // different facts — the fix all four providers passed round 3 under.
  {
    name: 'resolve-file-conflict',
    description:
      'Propose a merged version of a file whose local edits conflict with a newer on-disk version.',
    body: `The user has unsaved edits to a file that changed on disk since they opened it. You are given the file's path, their current in-editor draft, and the latest on-disk content. Merge them into one coherent version and call propose_file_merge with the full merged content — never partial content, never a diff.

Steps:
1. Read the path, draft content, and on-disk content from the message below.
2. Reconcile the two versions: keep the user's intent from their draft wherever it doesn't conflict with what changed on disk, and keep the on-disk changes wherever the draft didn't touch that part of the file. If the same region was changed in both, prefer the user's draft for it, since they are the one asking for help resolving this — but say so plainly in your explanation.
   "Same region" means the same fact or field was given two different, incompatible values — not just the same line position. A JSON key set to \`30\` in the draft and \`60\` on disk is a real conflict (same key, incompatible values): keep the draft's \`30\`. Two bullets that happen to occupy the same line position but state different, compatible facts — e.g. draft adds "Added a new section on deployment steps" where on-disk instead has "Updated the license year to 2026" — are not a conflict just because they landed on the same line; nothing about either statement contradicts the other, so keep both as separate lines rather than dropping one.
3. Call propose_file_merge with: path (exactly as given), mergedContent (the complete file, not a snippet or diff), and explanation (one sentence on what you kept, dropped, or combined).
4. Do not call any other tool. Do not ask the user a clarifying question first — produce your best merge and let them review and edit it before saving; that review is the whole point of this flow.

This skill has exactly one valid response: a single propose_file_merge tool call carrying the full merged content. Writing the merge out as a chat message — prose, a markdown table, a bullet list, anything — does not satisfy this skill, no matter how correct that text is, because the user's editor only updates from the tool call's arguments; text left in chat is invisible to it. propose_file_merge is already bound and callable the moment this skill is active — if it looks unavailable or absent from your tools for this turn, that reading is wrong; call it anyway, with the real merged content as the mergedContent argument.`,
  },
  // First draft, structurally complete against the design
  // (docs/superpowers/specs/2026-10-16-create-skill-design.md) but not yet
  // eval-tightened against a real run — expect this to need the same kind
  // of iterative tightening create-workspace/create-project/
  // resolve-file-conflict's bodies above needed, once suites/create-skill.yaml
  // has been run against real models.
  {
    name: 'create-skill',
    description:
      'Guide the user through creating a new skill, or repairing/upgrading an existing one — for the app-wide Skill Manager or the current workspace.',
    body: `Guide the user through creating a new Agent Skill, or repairing/upgrading one that already exists. This covers the skill's SKILL.md (frontmatter + body) and its scripts/references artifacts — not evals, which this skill does not handle yet.

Once a skill is invoked, an "Available Artifacts" section listing its current scripts/references and the exact read_skill_reference/run_skill_script call for each is generated and appended automatically — never write that call-out text into a skill's body yourself. If the body needs to reference an artifact at all, plain narrative prose ("see references/operations.md for the detailed steps") is enough; the generated section is what tells the model the exact tool call to use, so getting that syntax right is never the author's job.

Every question to the user anywhere in this flow — scope, repair framing, field collection, the cross-scope collision warning, the final confirmation — is its own ask_user tool call, never plain chat text. This holds even when you're confident you already know the right answer (an obvious scope, an obvious fix for a missing field, a complete-looking request): being confident which value belongs is not the same as the user having confirmed it, and skipping ask_user because you're sure skips the one chance they have to correct a wrong guess before anything is written. If you catch yourself drafting an explanation or a question as your reply's own text, stop and make it an ask_user call instead.

Step 1 (always first, before anything else): determine which path applies below.
- Take the REPAIR path only when the user is asking to fix, change, or repair a skill they believe already exists ("fix my X skill", "something's wrong with X", "update X") — not merely because a name is mentioned. Giving a brand-new skill a name as part of a creation request (e.g. "make a skill called X") is not this — that's the CREATE path.
- A bare invocation with no repair language yet (e.g. just "/create-skill" on its own) is also not repair — take the CREATE path; its own first step (asking scope) handles a request with nothing else specified.
- Once you know which path applies, follow only that path's steps. They have their own independent numbering and never refer back to each other — you will never need both at once.

## CREATE path

1. Determine scope — app-wide (the Skill Manager, visible everywhere) or this workspace (.agents/skills, visible only here).
   - If there is no workspace in this conversation, app-wide is the only option — state that plainly, don't ask.
   - If the user's own message already states the scope explicitly (e.g. "app-wide", "just for this workspace", "in the Skill Manager"), treat it as settled — don't ask again just because a workspace happens to also be available.
   - Otherwise ask with its own, single ask_user call using kind: "multiple_choice" (choices: the two scopes), separate from any other question and before collecting anything else in step 2. Never fold this into a batched free_text question — it specifically needs the multiple_choice buttons, not prose. Never infer it from ambient context either (e.g. "we're in a workspace chat, so default to workspace") — only the user's own stated scope or this dedicated question settles it.
2. Collect what you need in as few batched ask_user calls as possible — do not ask one field at a time: name (lowercase, hyphenated — this becomes the slash command), description, body, and whether any scripts or reference files are needed.
   - The description field is not a summary — it's the literal text search_skills and the slash menu match against, so it needs concrete trigger phrases a user would actually type (e.g. "wiki search tips, search syntax help" rather than "helps with search"). Say this to the user as part of asking, so they understand why it matters.
   - Use kind: "free_text" for name/description/body — never kind: "multiple_choice" with invented example values, since none of these fields has a fixed set of valid answers.
3. Before confirming anything: use search_skills to check whether a skill with this name already exists in the *other* scope (the one not chosen in step 1). search_skills's result never says which scope a match is in — that's fine, you don't need to know. If a same-named skill turns up, your very next tool call is ask_user (folding the warning into step 4's confirmation question itself, not a separate prose explanation first): never get_skill_source, never a second search_skills call, never anything else aimed at pinning down the exact scope — a workspace skill shadows a same-named app-wide one when both exist, and that's the entire warning. Say so, let them rename or proceed with that understood, and move on; this is a heads-up, not a blocker, and trying to resolve it further only spends a turn you don't have.
4. Summarize the full draft (frontmatter fields plus any planned scripts/references, plus any step 3 collision warning) and confirm with a single yes/no ask_user call before writing anything. This applies even when every field was already given up front in the user's own message — a complete request is exactly the case this step exists for, not a reason to skip straight to a write.
5. Only after explicit confirmation: call create_app_skill (app scope) or create_workspace_skill (workspace scope) with exactly what was confirmed. If the tool reports a conflict or validation error, relay it as-is and stop — do not retry with a different name or otherwise route around the rejection; wait for the user's next instruction.
6. If scripts or reference files were part of the draft, add each one with create_skill_artifact after the SKILL.md write succeeds. For any script artifact, immediately call #test_skill_artifact to dry-run it and show the result before finishing — a direct tool call, not a prose question asking whether the user wants it tested; this is a sanity check during authoring, not how the skill's script runs for real once the skill is invoked later.
7. Wrap up with a brief confirmation of what was created. For a workspace-scope write, say plainly that the file is on disk but not committed — the user reviews and commits it through the workspace's own normal git flow, the same as any other change there.

## REPAIR path

1. Call get_skill_source with the skill's name first, before asking anything else — the skill's existing scope (which get_skill_source reports) is already the answer, so don't ask the user to pick one. If it reports the name is ambiguous (exists in both scopes), ask the user (via ask_user) which one they mean before doing anything else; do not guess.
2. Read its "issue" field (if any) and ask about that specific, concrete problem via its own #ask_user call — never restart a blank interview for a skill that already has content.
3. Once the user answers, summarize exactly what you're about to change (the field, and its new value) and confirm with a single yes/no #ask_user call before writing anything — a direct answer from the user is something to confirm, not yet an instruction to write. Never compose the new value yourself from the existing body or name and skip straight to editing: however plausible your own guess looks, it is still a guess the user never approved, and this confirmation step exists for exactly that case.
4. Only after explicit confirmation: call edit_app_skill (app scope) or edit_workspace_skill (workspace scope) with exactly what was confirmed. If the tool reports a conflict or validation error, relay it as-is and stop — do not retry with a different name or otherwise route around the rejection; wait for the user's next instruction.
5. If the fix touches scripts or reference files, use update_skill_artifact for an existing file (or create_skill_artifact for a new one) after the SKILL.md edit succeeds. For any script artifact, immediately call #test_skill_artifact to dry-run it and show the result before finishing — a direct tool call, not a prose question asking whether the user wants it tested.
6. Wrap up with a brief confirmation of what changed. For a workspace-scope write, say plainly that the file is on disk but not committed — the user reviews and commits it through the workspace's own normal git flow, the same as any other change there.`,
  },
  // Deliberately not registered in GATED_SKILL_REGISTRATIONS
  // (gated-skill-registrations.ts) — wiki_create_page/wiki_update_page/etc.
  // must stay globally visible, not disappear whenever a different skill is
  // active. See the design doc's Decisions table, "Tool gating" row, for why.
  //
  // First tightening, added after a real eval run (suites/ingest-document.yaml,
  // 2026-11-16) against four providers:
  // - local: 5/7 (71.4%), Lemonade: 2/7 (28.6%), Ornith: 5/7 (71.4%),
  //   Digital Ocean: 4/7 (57.1%).
  // idoc-005 (revise plan after "No") failed for all four providers, 0/4 — the
  // single worst result in the suite. All four skip the required second
  // ask_user gate and go straight to execution once the user gives concrete
  // revision feedback. Digital Ocean's own reasoning states the
  // rationalization verbatim: "The user already approved proceeding with just
  // the expense page, so no more ask_user." Step 6's existing exception-closing
  // sentence only covers an opening message that already reads like a
  // go-ahead; step 7 creates an equivalent but previously uncovered loophole
  // by handing the model fresh, specific feedback right before it's supposed
  // to loop back to the gate. Added a sentence to step 7 naming this exact
  // rationalization and closing it.
  // idoc-004 (sourceText on write) failed for three of four providers
  // (Lemonade, Ornith, Digital Ocean — only local passed). All three built the
  // page body correctly from the seeded document text but never included
  // sourceText in the wiki_create_page call at all — not malformed, not
  // empty, simply absent every time. The prior wording ("This is an easy
  // optional param to drop") read as a warning/aside rather than an
  // instruction to act on. Rewrote step 8 to name corpus/content and
  // sourceText as two separate required fields filled from the same excerpt,
  // and added an explicit pre-call self-check for the key's presence.
  // idoc-001 (single-topic one-item plan) failed for local only (among the
  // providers where this was a skill-wording issue — see below for Lemonade's
  // separate failure on this same scenario). local never reached the plan step
  // at all: it got stuck re-querying wiki_search with rephrased terms, trying
  // to resolve its own uncertainty about topic boundaries, and the judge
  // noted "a rambling, exploratory internal monologue" with no plan ever
  // presented. Step 4 had no boundary telling the model the overlap-check is
  // a finite step. Added a sentence bounding it to one search per candidate
  // topic before moving on to step 5.
  // Flagged, not fixed — not skill-wording gaps:
  // - Lemonade failed idoc-001/idoc-002/idoc-006 (3 of its 5 failures) the
  //   identical way each time: it reasoned correctly, even stated in its own
  //   reasoning that it would call ask_user, then emitted the question as
  //   plain prose ending in "?" instead of an actual tool call (the harness's
  //   prose_question flag, which fired exactly twice in its run). This is a
  //   model/transport formatting reliability issue — no amount of wording
  //   changes whether a model that already decided correctly successfully
  //   encodes that decision as a tool call. Left untouched; if it recurs next
  //   run, that points at a Lemonade-specific transport issue, not another
  //   wording round.
  // - Digital Ocean failed idoc-006 with a genuine hallucination: it
  //   fabricated an entire fake meeting transcript (invented speakers, a fake
  //   product deprecation timeline, fake pricing) in direct contradiction of
  //   step 3's existing, already-explicit sentence forbidding exactly that.
  //   The correct instruction is already there in the exact words needed —
  //   this reads as a capability ceiling for this model under this harness,
  //   not a closable wording gap. Flagged to verify on the next run rather
  //   than assumed fixed by anything in this round.
  //
  // Second tightening, added after a rerun of the first tightening above
  // against bin/eval.ts's now-hermetic skill seeding (the first tightening's
  // eval run had silently been testing the pre-tightening wording the whole
  // time — a harness bug, fixed separately — so this is the first run that
  // actually exercised this skill's current text):
  // idoc-005 (revise plan after "No") still failed 0/4, byte-for-byte
  // identical to the untested round for `local` despite the new sentence
  // genuinely being present in the prompt this time (confirmed via the raw
  // request transcript). Root cause turned out to be structural, not
  // wording: this skill's step 7 told the model to "stop the turn and wait
  // for the user's next message" — but skill-expansion only re-injects this
  // skill's body while the original /ingest-document message remains the
  // *latest* human message in the conversation (see
  // skill-expansion.middleware.ts; historical slash-command messages are
  // deliberately never re-expanded). A free-standing chat reply from the
  // user becomes the new latest message and silently drops every one of
  // this skill's steps from view — confirmed directly: Digital Ocean's own
  // reasoning for this scenario falls back to the unrelated, always-on
  // wiki_navigation rule ("the user has already decided, so create the page
  // now") because nothing from this skill was in context at all. Rewrote
  // step 7's "No" branch to collect the revision through a second, chained
  // ask_user (free_text) call instead of waiting for an ordinary reply — the
  // answer comes back as a tool result, not a new human message, so the
  // original invocation stays current and every later step stays visible.
  // idoc-004 (sourceText on write) was confounded by an unrelated bug in the
  // eval scenario itself: it seeded an extra, unnecessary `user: "Yes,
  // proceed."` turn after the ask_user confirmation, which — by the same
  // mechanism above — also wiped the skill body from context. That seeded
  // turn didn't reflect anything real: answering a yes/no ask_user prompt in
  // the actual app resumes the interrupted call and produces a tool result,
  // never a new human message, so the extra turn was never representative
  // and has been removed from suites/ingest-document.yaml. Separately, and
  // independent of that scenario bug, Digital Ocean's transcript for this
  // same scenario surfaced a real, evidenced conflict: its reasoning quotes
  // the sourceText parameter's own tool-schema description verbatim ("Only
  // set this when explicitly instructed...") as its stated reason for
  // omitting it — the tool schema was actively arguing against what this
  // skill asks for. Reworded that description in both wiki-create-page.tool.ts
  // and wiki-update-page.tool.ts to stop treating "set it" as the exception.
  // idoc-001 (single-topic one-item plan) still failed for `local`, but the
  // first tightening's step-4 fix demonstrably worked on its own terms — no
  // more rephrased re-querying. The failure just moved one step earlier: the
  // model now invents extra candidate topics out of one short checklist
  // ("Laptop provisioning", "VPN access", "Slack invite" as three separate
  // candidates from one onboarding checklist) and burns the turn deliberating
  // between a one-page and three-page split, never reaching the gate. Added a
  // sentence to step 3 naming this exact pattern — a connected checklist or
  // process is one candidate, not one candidate per item it lists.
  // Lemonade regressed from 2/7 to 1/7, with idoc-003 newly failing and its
  // prose_question count rising from 2 to 3 — but the evidence points away
  // from this round's edits: in every affected scenario the model's actual
  // plan content scored a perfect 10/10 from the judge (including idoc-003's
  // overlap/append judgment, exactly what the first tightening's step-4 fix
  // targets), and it still failed purely because it phrased the
  // confirmation question as plain prose ending in "?" instead of calling
  // ask_user — the identical pre-existing issue already flagged above,
  // recurring on one more scenario. No mechanism ties step 4/7/8's content to
  // whether a model encodes a question as a tool call; left untouched.
  //
  // Third tightening, added after rerunning the second tightening above for
  // real (suites/ingest-document.yaml, 2026-11-16): local and Digital Ocean
  // both reached 7/7 (100%) — the step 7 architecture fix and the sourceText
  // schema rewording both held up under an actual test this time.
  // Ornith regressed on two scenarios that had passed in every prior round
  // (idoc-006, idoc-007), neither touched by the second tightening's edits:
  // - idoc-006 (empty input) — Ornith fabricated an entire fictional
  //   "Nimbus Analytics" release-notes document, in direct violation of
  //   step 3's existing, already-explicit prohibition — the identical
  //   hallucination class already flagged for Digital Ocean on this same
  //   scenario in the first tightening above (which, notably, did not
  //   hallucinate this round). Cross-provider, already-flagged, not a
  //   wording gap — the instruction is already as explicit as it can be.
  // - idoc-007 (stop after write conflict) — Ornith called wiki_read_page on
  //   the blocking page instead of relaying the conflict and stopping. Root
  //   cause was this skill's own wording: step 11 said to relay-and-stop,
  //   then immediately followed with "the tool's own response already says
  //   what to do next (read the blocking page, append, or force...)" — which
  //   reads as license to go do one of those right away. Reworded to say
  //   those are the user's options to choose from after the conflict is
  //   relayed, never an immediate follow-up action to take unprompted.
  // Ornith's idoc-004 (sourceText) still failed even with the schema fix
  // confirmed present in the tool source — its own reasoning states the
  // correct intent ("I need to include sourceText verbatim") immediately
  // before emitting a tool call that omits the field anyway. Reasoning is
  // correct; encoding it into the structured call isn't. Reads as a
  // capability ceiling at this model's quantization, not a further wording
  // or schema gap — left untouched.
  // Lemonade (3/7, prose_question: 4) showed the identical prose-vs-tool-call
  // pattern already flagged above on all four of its failures, including a
  // newly-affected idoc-006 — every one had correct reasoning (one scenario
  // even quoted this skill's own step 3 sentence near-verbatim) and correct
  // plan content where a content judge ran, failing only on whether the
  // decided tool call actually got emitted as a tool call versus prose.
  // idoc-005 is mechanically more exposed to this now (three sequential
  // ask_user opportunities instead of one), which plausibly explains both
  // its continued failure and part of the risen count without any of it
  // being wording-fixable. Left untouched.
  {
    name: 'ingest-document',
    description:
      'Decompose a pasted or attached document into wiki pages, planning the breakdown and ' +
      'confirming it before writing anything — trigger on "ingest this document into the wiki", ' +
      '"break this report into wiki pages", "turn these notes into wiki pages", or "file this doc ' +
      'in the wiki", not just a literal mention of "ingest".',
    body: `Guide the agent through decomposing a pasted or attached document into wiki pages — planning and confirming the breakdown before writing anything, rather than diving straight into wiki_create_page/wiki_update_page calls. This applies whenever the user pastes a document (meeting notes, a report, an email thread) as this skill's command args, or attaches a file and invokes this skill — not just when their own wording literally says "ingest."

Scoped to documents that fit in the model's own context window. There is no chunking mechanism here — if the document looks too large to have been read in full, say so and stop rather than guessing from a truncated read.

Steps:

1. Resolve the domain. If this is a workspace chat with a bound wiki domain (see "Bound wiki domain" in the workspace context, if present), use it — don't ask which domain to use, and don't call wiki_locate "to double-check," when one is already bound. Otherwise, if the user named a domain in their own message, use that. Otherwise call wiki_locate: if it reports a single strong match, use it; if it reports ambiguous candidates, ask the user with ask_user (kind: "multiple_choice", the candidate ids as choices) before doing anything else.

2. Orient. Call wiki_orient on the resolved domain before judging anything about the document. Its SCHEMA.md is this domain's own Page Thresholds and tag taxonomy — apply that domain's rules, not a generic rule of thumb from memory or from a different domain you've seen before. Do this even when you're confident you already know how this domain is organized from an earlier turn; wiki_orient is cheap and the schema may have changed since.

3. Read and segment. Read the document — it's either pasted directly as this skill's command args, or surfaced as an attachment by the existing attachment-handling middleware. Identify the distinct entities, concepts, comparisons, or Q&A pairs that clear *this* domain's Page Threshold from wiki_orient's schema — not a generic "is this big enough to matter" instinct. A single connected process, checklist, or policy is one candidate topic, not one candidate per item or step it lists — a checklist saying a new hire gets a laptop, VPN access, and a Slack invite is one "Onboarding Checklist" candidate, not three separate candidates for laptop, VPN, and Slack; don't manufacture extra candidates by treating a list's individual entries as topics in their own right. Passing mentions and minor supporting details don't get their own entry; fold them into whatever topic they support.
   - No document actually provided (empty command args, no attachment) → stop here and ask what to ingest with a free_text ask_user call. Do not invent a placeholder document, example content, or a plan for "typical" content just so you have something to show — there is nothing to plan yet.

4. Check for overlap. For each candidate topic from step 3, call wiki_search (scoped to the resolved wikiId) and wiki_read_page on anything that looks relevant, to check whether it already has a home in the wiki. Skipping this and treating every candidate as brand-new is exactly the mistake step 5's "append" option exists to avoid — a document that updates or extends existing content is common, not the exception. One wiki_search per candidate topic (plus wiki_read_page only on an actual hit) is enough to decide new-vs-append — don't keep re-querying with rephrased search terms to resolve your own uncertainty about where a topic's boundaries sit. Move on to step 5 once each candidate has had its one search.

5. Build the plan. One line per candidate topic: new page (title + section type) / append to an existing page (which page, what's being added) / skip (why it doesn't clear the threshold). A short, single-topic document can produce a one-item plan — don't manufacture extra splits across several pages just to look thorough, and don't force every passing mention into its own line either; both are the same mistake in opposite directions.

6. Present and gate — in the same turn. State the plan as a numbered list in your reply text, then call ask_user with kind: "multiple_choice" and choices exactly ["Yes, proceed", "No — I'll explain what to change"]. The question text only needs to ask for approval of "the plan above" — don't repeat the list inside the question itself, it's already sitting in your reply. This gate applies even when the user's own message already reads like a go-ahead — "here's our onboarding doc, file it in the wiki" is a request to run this skill, not a substitute for the plan-then-confirm sequence; build and present the plan exactly as above, then still call ask_user. A document that looks obviously well-organized, or a plan with only one item, is not an exception to this gate either.

7. Branch on the answer, and only on this specific exchange:
   - "Yes, proceed" → continue to step 8 immediately, with exactly the plan you just confirmed. Don't re-derive it, don't re-run wiki_search, and don't re-read the document first — that work already happened before the gate.
   - "No — I'll explain what to change" → immediately call ask_user again, in the same turn, with kind: "free_text" asking what they'd like changed (e.g. "What would you like to change about the plan?"). Do this right away — don't end the turn, and don't guess at what might be wrong on your own reasoning first. This has to happen through ask_user rather than by waiting for an ordinary chat reply: once this exchange ends without it, these instructions won't be back in view for whatever the user types next. Once you have their answer, revise the plan using it, restate the revised plan as a new numbered list, and run the same ask_user gate again (back to step 6). Giving concrete, specific feedback (e.g. "drop the VPN page, just keep expense policy") is not the same as approving the revised plan — it's the input the revision is built from, and it still has to clear the same gate the first draft did. Don't treat the detail or specificity of the feedback as implicit sign-off that lets you skip straight to step 8; "the user already told me what they want, so there's no need to ask again" is exactly the rationalization this step exists to close. A restated plan that comes back unchanged — same titles, same splits, same skips as before — means the feedback wasn't actually applied; something has to change, however small.

8. Execute. For each confirmed plan item, call wiki_create_page or wiki_update_page (append or replace, matching what that plan line said). Every one of these calls fills two separate content fields from the same source excerpt, not one: corpus/content holds your organized page body, and sourceText holds the untouched original passage, copied verbatim from the document — even though this duplicates text you already used for corpus/content. Before sending the call, check the arguments you're about to submit for a sourceText key; if it isn't there, add it now. Treating sourceText as optional-and-skippable is the single most common mistake here — it's listed as an optional parameter in the tool's own schema, but this skill requires it on every call in this step; omitting it is not a smaller, acceptable version of this step, it's leaving the step half-done.

9. Cross-link. Call wiki_add_cross_link between pages touched this turn that are genuinely related to each other. Don't force a link between two pages just because they came from the same source document — the relationship has to be real content-level overlap, not shared provenance.

10. Lint. Call wiki_lint on the domain and fix anything it surfaces before finishing — same norm the Wiki Chat ingestion agent already follows after a write batch. Don't finish the turn with known lint findings still open.

11. Relay failures. If any wiki_create_page or wiki_update_page call in step 8 reports a conflict (e.g. "duplicate" despite the plan saying "new" — a stale search result or a race) or a validation error, relay the tool's own message to the user as-is and stop there — don't retry with a workaround, don't silently force past it, and don't continue executing the plan's remaining items as if nothing happened. The tool's own response names what could come next (read the blocking page, append, or force with a distinguishing title) — that's context for the user's decision, not a next action for you to take on your own. Reading the blocking page, appending, or forcing are all things you do only after relaying the conflict and getting the user's direction, never as an immediate, silent follow-up to the conflict itself — calling wiki_read_page right away because the conflict message mentioned it is the same mistake as retrying with a workaround.`,
  },
];
