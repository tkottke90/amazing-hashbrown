import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createSkillGatedToolsMiddleware } from './skill-gated-tools.middleware.js';

function fakeTool(name: string) {
  return { name } as unknown as { name: string };
}

// Stands in for SkillsManager.list() — createSkillGatedToolsMiddleware no
// longer takes a static registrations array (issue #409); it reads
// resolveSkillGatedRegistrations(getSkills().list()) fresh on every call.
// Each entry's `tools` mirrors SKILL.md frontmatter: a comma-separated
// string, not an array.
function fixtureSkills(entries: { name: string; tools: string }[]) {
  return () => ({ list: () => entries });
}

const ALWAYS_ON = [fakeTool('ask_user'), fakeTool('wiki_search')];
const GATED = [fakeTool('create_workspace'), fakeTool('create_project')];

function fakeRequest(activeSkill: string | null) {
  return {
    tools: [...ALWAYS_ON, ...GATED],
    state: { activeSkill },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/skill-gated-tools.middleware', () => {
  const getSkills = fixtureSkills([
    { name: 'create-workspace', tools: 'create_workspace' },
    { name: 'create-project', tools: 'create_project' },
  ]);

  it('hides gated tools from the model when no skill is active', async () => {
    const middleware = createSkillGatedToolsMiddleware(getSkills);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest(null), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search']);
  });

  it("exposes only the matching skill's tools when that skill is active", async () => {
    const middleware = createSkillGatedToolsMiddleware(getSkills);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest('create-workspace'), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal([
      'ask_user',
      'wiki_search',
      'create_workspace',
    ]);
  });

  it('does not expose a gated tool for an unregistered activeSkill value', async () => {
    const middleware = createSkillGatedToolsMiddleware(getSkills);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest('some-unrelated-skill'), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search']);
  });

  it('never exposes the MCP (colon-containing) half of a skill\'s declared tools — that is skill-gated-mcp-tools.middleware.ts\'s job', async () => {
    const getMixedSkills = fixtureSkills([
      { name: 'n8n-workflow-sync', tools: 'create_workspace,n8n:workflow_search' },
    ]);
    const middleware = createSkillGatedToolsMiddleware(getMixedSkills);
    const request = {
      tools: [...ALWAYS_ON, fakeTool('create_workspace')],
      state: { activeSkill: 'n8n-workflow-sync' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(request, handler);

    // create_workspace (built-in) passes through; nothing here ever adds
    // n8n:workflow_search (it was never present in request.tools to begin
    // with, and this middleware only filters, never adds).
    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search', 'create_workspace']);
  });

  // These describe blocks exercise the exact tool sets the previously
  // hardcoded GATED_SKILL_REGISTRATIONS array encoded for
  // resolve-file-conflict and create-skill, now expressed as fixture skill
  // frontmatter instead of a production import — so a future change to
  // those skills' seeded `tools` values (default-skills.ts) that drops or
  // misnames one of these tool names is still a one-file skill-fixture
  // check away from being caught, even though this file no longer imports
  // the real seed data (gated-skill-registrations.ts was deleted in #409;
  // the source of truth for these two skills' tools now lives in
  // default-skills.ts, covered separately).
  describe('propose_file_merge (resolve-file-conflict)', () => {
    const tools = [...ALWAYS_ON, ...GATED, fakeTool('propose_file_merge')];
    const getResolveSkills = fixtureSkills([
      { name: 'resolve-file-conflict', tools: 'propose_file_merge' },
    ]);

    function requestWith(activeSkill: string | null) {
      return {
        tools,
        state: { activeSkill },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    it('is hidden when resolve-file-conflict is not the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(getResolveSkills);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith(null), handler);

      expect(seenTools.map((t) => t.name)).to.not.include('propose_file_merge');
    });

    it('is exposed once resolve-file-conflict is the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(getResolveSkills);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith('resolve-file-conflict'), handler);

      expect(seenTools.map((t) => t.name)).to.include('propose_file_merge');
    });
  });

  describe('create-skill tools', () => {
    const CREATE_SKILL_TOOL_NAMES = [
      'create_app_skill',
      'edit_app_skill',
      'create_workspace_skill',
      'edit_workspace_skill',
      'get_skill_source',
      'create_skill_artifact',
      'update_skill_artifact',
      'delete_skill_artifact',
      'test_skill_artifact',
    ];
    const tools = [...ALWAYS_ON, ...GATED, ...CREATE_SKILL_TOOL_NAMES.map(fakeTool)];
    const getCreateSkillSkills = fixtureSkills([
      { name: 'create-skill', tools: CREATE_SKILL_TOOL_NAMES.join(',') },
    ]);

    function requestWith(activeSkill: string | null) {
      return {
        tools,
        state: { activeSkill },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    it('hides all nine tools when create-skill is not the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(getCreateSkillSkills);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith(null), handler);

      for (const name of CREATE_SKILL_TOOL_NAMES) {
        expect(seenTools.map((t) => t.name)).to.not.include(name);
      }
    });

    it('exposes all nine tools together once create-skill is the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(getCreateSkillSkills);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith('create-skill'), handler);

      for (const name of CREATE_SKILL_TOOL_NAMES) {
        expect(seenTools.map((t) => t.name)).to.include(name);
      }
    });
  });
});
