import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { Command, MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { SkillsManager } from '@tkottke90/skills-manager';
import { makeUseSkillTool } from './use-skill.tool.js';
import { makeReadSkillReferenceTool } from './read-skill-reference.tool.js';
import { createSkillGatedToolsMiddleware } from '../skill-gated-tools.middleware.js';
import { skillScopedToolsMiddleware } from '../skill-scoped-tools.middleware.js';

// Scripted model: first turn calls use_skill, the turn after the tool result
// answers in plain text. Records the tool names bound on each model call so a
// test can see what the model was actually offered before/after the skill loaded.
class ScriptedUseSkillModel extends BaseChatModel {
  boundPerCall: string[][] = [];
  private pending: string[] = [];

  constructor(private skillName: string) {
    super({});
  }
  _llmType() {
    return 'scripted-use-skill';
  }
  bindTools(tools: Array<{ name: string }>) {
    this.pending = tools.map((t) => t.name);
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.boundPerCall.push(this.pending);
    const last = messages[messages.length - 1]!;
    if (last.getType() === 'tool') {
      return { generations: [{ message: new AIMessage('Done.'), text: 'Done.' }] };
    }
    return {
      generations: [
        {
          message: new AIMessage({
            content: '',
            tool_calls: [{ id: 'call_1', name: 'use_skill', args: { name: this.skillName } }],
          }),
          text: '',
        },
      ],
    };
  }
}

// toolCallId and state ride on the invoke config, which is where the tool's
// ToolRuntime reads them from (same shape read-skill-reference.tool.test.ts uses).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function config(state?: { activeSkill: string | null }): any {
  return { toolCallId: 'call-1', ...(state ? { state } : {}) };
}

describe('agents/tools/use-skill.tool', () => {
  let dir: string;
  let manager: SkillsManager;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'use-skill-tool-test-'));
    manager = new SkillsManager(dir);
    await manager.boot();
    await manager.create({
      name: 'n8n-opts',
      description: 'How to modify N8N workflow nodes.',
      body: 'Edit the node via the n8n tools.',
    });
    await manager.create({
      name: 'other-skill',
      description: 'Another skill.',
      body: 'Other body.',
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a Command that sets the active skill and carries the body [unit]', async () => {
    const tool = makeUseSkillTool(async () => manager);
    const result = await tool.invoke({ name: 'n8n-opts' }, config());
    // ToolNode unwraps the Command's update; invoking the tool directly with
    // a tool call yields the Command wrapped as the tool's return value.
    const command = result as unknown as Command;
    expect(command).to.be.instanceOf(Command);
    const update = command.update as {
      activeSkill: string;
      messages: Array<{ content: string; tool_call_id: string; name: string }>;
    };
    expect(update.activeSkill).to.equal('n8n-opts');
    expect(update.messages[0]?.content).to.include('Edit the node via the n8n tools.');
    expect(update.messages[0]?.tool_call_id).to.equal('call-1');
    expect(update.messages[0]?.name).to.equal('use_skill');
  });

  it('accepts a leading slash on the name like the slash command does [unit]', async () => {
    const tool = makeUseSkillTool(async () => manager);
    const command = (await tool.invoke({ name: '/n8n-opts' }, config())) as unknown as Command;
    expect((command.update as { activeSkill: string }).activeSkill).to.equal('n8n-opts');
  });

  it('returns text and sets no state for an unknown skill [unit]', async () => {
    const tool = makeUseSkillTool(async () => manager);
    const result = await tool.invoke({ name: 'nope' }, config());
    const text =
      typeof result === 'string' ? result : String((result as { content: unknown }).content);
    expect(text).to.include('not found');
    expect(text).to.include('search_skills');
    expect(result).to.not.be.instanceOf(Command);
  });

  it("tells the model when a different skill is replaced, since that skill's tools go away [unit]", async () => {
    const tool = makeUseSkillTool(async () => manager);
    const command = (await tool.invoke(
      { name: 'n8n-opts' },
      config({ activeSkill: 'other-skill' }),
    )) as unknown as Command;
    const update = command.update as { messages: Array<{ content: string }> };
    expect(update.messages[0]?.content).to.match(
      /^Replaced active skill "other-skill" with "n8n-opts"/,
    );
  });

  it('does not claim a replacement when the same skill is loaded again [unit]', async () => {
    const tool = makeUseSkillTool(async () => manager);
    const command = (await tool.invoke(
      { name: 'n8n-opts' },
      config({ activeSkill: 'n8n-opts' }),
    )) as unknown as Command;
    const update = command.update as { messages: Array<{ content: string }> };
    expect(update.messages[0]?.content).to.not.include('Replaced');
  });

  it('resolves the skill source on every call, not once at build time [unit]', async () => {
    let current = manager;
    const empty = new SkillsManager(mkdtempSync(join(tmpdir(), 'use-skill-empty-')));
    await empty.boot();
    const tool = makeUseSkillTool(async () => current);

    expect(await tool.invoke({ name: 'n8n-opts' }, config())).to.be.instanceOf(Command);
    current = empty;
    expect(await tool.invoke({ name: 'n8n-opts' }, config())).to.not.be.instanceOf(Command);
  });

  describe('a real agent run — confirms use_skill drives Active Skill through the graph', () => {
    function buildAgent(model: ScriptedUseSkillModel) {
      return createAgent({
        model,
        tools: [makeUseSkillTool(async () => manager), makeReadSkillReferenceTool()],
        middleware: [createSkillGatedToolsMiddleware(() => manager), skillScopedToolsMiddleware],
        checkpointer: new MemorySaver(),
      });
    }

    it('persists the loaded skill as activeSkill and puts its body in the thread [orchestration]', async () => {
      const agent = buildAgent(new ScriptedUseSkillModel('n8n-opts'));
      const config = { configurable: { thread_id: 'use-skill-1' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'update the node' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.activeSkill).to.equal('n8n-opts');
      const toolMessage = (state.values.messages as BaseMessage[]).find(
        (m) => m.getType() === 'tool',
      );
      expect(String(toolMessage?.content)).to.include('Edit the node via the n8n tools.');
    });

    it('offers Skill-Scoped Tools only after the skill is loaded [orchestration]', async () => {
      const model = new ScriptedUseSkillModel('n8n-opts');
      const agent = buildAgent(model);

      await agent.invoke(
        { messages: [{ role: 'human', content: 'update the node' }] },
        { configurable: { thread_id: 'use-skill-2' } },
      );

      expect(model.boundPerCall[0]).to.not.include('read_skill_reference');
      expect(model.boundPerCall[1]).to.include('read_skill_reference');
    });

    it('leaves activeSkill unset when the skill does not exist [orchestration]', async () => {
      const agent = buildAgent(new ScriptedUseSkillModel('nope'));
      const config = { configurable: { thread_id: 'use-skill-3' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'do it' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.activeSkill ?? null).to.equal(null);
    });
  });
});
