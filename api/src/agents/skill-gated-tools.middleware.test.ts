import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createSkillGatedToolsMiddleware } from './skill-gated-tools.middleware.js';

function fakeTool(name: string) {
  return { name } as unknown as { name: string };
}

const ALWAYS_ON = [fakeTool('ask_user'), fakeTool('wiki_search')];
const GATED = [fakeTool('create_workspace'), fakeTool('create_project')];

function fakeRequest(activeGatedSkill: string | null) {
  return {
    tools: [...ALWAYS_ON, ...GATED],
    state: { activeGatedSkill },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/skill-gated-tools.middleware', () => {
  const registrations = [
    { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
    { skillCommand: 'create-project', toolNames: ['create_project'] },
  ];

  it('hides gated tools from the model when no skill is active', async () => {
    const middleware = createSkillGatedToolsMiddleware(registrations);
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
    const middleware = createSkillGatedToolsMiddleware(registrations);
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

  it('does not expose a gated tool for an unregistered activeGatedSkill value', async () => {
    const middleware = createSkillGatedToolsMiddleware(registrations);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest('some-unrelated-skill'), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search']);
  });
});
