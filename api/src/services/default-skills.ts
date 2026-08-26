import type { CreateSkillInput } from '@tkottke90/skills-manager';

// Built-in, chat-invoked skills seeded on first boot (see bootSkillsManager
// below) — mirrors wiki.ts's DEFAULT_DOMAINS auto-seed pattern. These skills
// are pure instruction text (per the Skill-Gated Tools pattern in
// AGENTS.md § Composition over Customization): they tell the agent what
// fields to collect and when to call the real create_workspace/
// create_project tools, which do the actual validation and API work.
export const DEFAULT_SKILLS: CreateSkillInput[] = [
  {
    name: 'create-workspace',
    description: 'Create a new workspace conversationally, without leaving the chat.',
    body: `Guide the user through creating a workspace, then call the create_workspace tool.

Required field:
- name — the workspace name.

Optional fields:
- goal — what the workspace is for, in a sentence or two.
- wikiId — an existing wiki domain to bind this workspace to. Only ask if the user brings it up; don't ask by default. If they name one, the create_workspace tool validates it against the real wiki domain list itself and will tell you if it doesn't match.
- git — whether to initialize git in the workspace directory. Defaults to no.

Steps:
1. Parse whatever the user already gave you in their message.
2. If "name" is missing, ask for it with a single ask_user call — do not proceed without it. If other optional fields are also missing and worth asking about, batch them into that same question rather than asking one field at a time.
3. Once you have a name (and any other fields the user wants to set), summarize what you're about to create — including that the directory name will be derived automatically from the workspace name — and confirm with a yes/no ask_user call before creating anything.
4. Only after explicit confirmation, call create_workspace with the collected fields.
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
3. Once you have the required fields, summarize what you're about to create — including that the directory name will be derived automatically from the project name — and confirm with a yes/no ask_user call before creating anything.
4. Only after explicit confirmation, call create_project with the collected fields.
5. If the tool reports a conflict (name already in use) or a validation error, relay that message to the user as-is and stop — do not retry with a different name or otherwise route around the rejection. Wait for the user's next instruction.
6. On success, the resource card renders automatically — you don't need to summarize the result yourself beyond a brief confirmation.`,
  },
];
