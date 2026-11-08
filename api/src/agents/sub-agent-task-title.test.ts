import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { configManager } from '../config/env.js';
import { bootObservability } from '../services/observability.js';
import {
  bootWorkspaceStore,
  getWorkspaceStore,
  TASK_TITLE_MAX_LENGTH,
} from '../services/workspace-store.js';
import { generateSubAgentTaskTitle, triggerSubAgentTitleGeneration } from './sub-agent-task-title.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

describe('agents/sub-agent-task-title — generateSubAgentTaskTitle', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sub-agent-task-title-test-'));
    bootObservability(openDatabase(join(dir, 'observability.db')));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const goal =
    'Answer this question about an n8n workflow: how does the Gate node use the output of the Get Decisions node?';

  it('trims and unquotes the model response [unit]', async () => {
    const model = new FakeListChatModel({ responses: ['  "Gate node decision logic"  '] });

    const title = await generateSubAgentTaskTitle(model, undefined, undefined, goal);

    expect(title).to.equal('Gate node decision logic');
  });

  it('defensively truncates a response that ignores the length instruction [unit]', async () => {
    const overlong = 'A'.repeat(TASK_TITLE_MAX_LENGTH + 40);
    const model = new FakeListChatModel({ responses: [overlong] });

    const title = await generateSubAgentTaskTitle(model, undefined, undefined, goal);

    expect(title.length).to.equal(TASK_TITLE_MAX_LENGTH);
  });

  it('throws on an empty/whitespace-only response [unit]', async () => {
    const model = new FakeListChatModel({ responses: ['   '] });

    let caught: unknown;
    try {
      await generateSubAgentTaskTitle(model, undefined, undefined, goal);
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
  });

  it('throws when the model itself throws [unit]', async () => {
    let caught: unknown;
    try {
      await generateSubAgentTaskTitle(new ThrowingChatModel({}), undefined, undefined, goal);
    } catch (err) {
      caught = err;
    }

    expect(caught).to.be.instanceOf(Error);
  });

  it('includes the goal text in the prompt [unit]', async () => {
    let capturedPrompt = '';
    class CapturingModel extends FakeListChatModel {
      override async invoke(promptInput: unknown, options?: unknown) {
        capturedPrompt = String(promptInput);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return super.invoke(promptInput as any, options as any);
      }
    }
    const model = new CapturingModel({ responses: ['Gate node logic'] });

    await generateSubAgentTaskTitle(model, undefined, undefined, goal);

    expect(capturedPrompt).to.include(goal);
  });
});

describe('agents/sub-agent-task-title — triggerSubAgentTitleGeneration [orchestration]', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sub-agent-task-title-trigger-test-'));
    bootObservability(openDatabase(join(dir, 'observability.db')));
    bootWorkspaceStore(openDatabase(join(dir, 'workspace.db')));
  });

  afterEach(() => {
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies the generated title to the task on success', async () => {
    const task = getWorkspaceStore().createTask({ title: 'placeholder', description: 'goal' });
    const model = new FakeListChatModel({ responses: ['Gate node decision logic'] });

    await triggerSubAgentTitleGeneration(task.id, 'the full goal text', model);

    expect(getWorkspaceStore().getTask(task.id)!.title).to.equal('Gate node decision logic');
  });

  it('keeps the placeholder title and does not throw when the model fails', async () => {
    const task = getWorkspaceStore().createTask({ title: 'placeholder', description: 'goal' });

    await triggerSubAgentTitleGeneration(task.id, 'the full goal text', new ThrowingChatModel({}));

    expect(getWorkspaceStore().getTask(task.id)!.title).to.equal('placeholder');
  });

  it('keeps the placeholder title and does not throw when no provider is configured', async () => {
    // No providers/defaultProvider configured, and no modelOverride — exercises
    // the real production path's createProvider() failure, matching D5/ADR-0059's
    // "never block or fail the Dispatch call" requirement.
    const task = getWorkspaceStore().createTask({ title: 'placeholder', description: 'goal' });

    await triggerSubAgentTitleGeneration(task.id, 'the full goal text');

    expect(getWorkspaceStore().getTask(task.id)!.title).to.equal('placeholder');
  });

  it('is a silent no-op when the task no longer exists', async () => {
    const model = new FakeListChatModel({ responses: ['Gate node decision logic'] });

    let caught: unknown;
    try {
      await triggerSubAgentTitleGeneration('no-such-task', 'the full goal text', model);
    } catch (err) {
      caught = err;
    }

    expect(caught).to.equal(undefined);
  });
});
