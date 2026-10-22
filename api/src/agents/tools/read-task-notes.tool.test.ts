import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { createTaskFileStateMiddleware } from '../task-file-state.middleware.js';
import { makeReadTaskNotesTool } from './read-task-notes.tool.js';

// Captures whatever read_task_notes returned, by replying with the tool
// result's own content on the next (post-tool) turn — so the test can
// assert on it via the final AI message rather than reaching into graph
// internals.
class ScriptedChatModel extends BaseChatModel {
  _llmType() {
    return 'scripted-fake';
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages[messages.length - 1]!;
    if (last.getType() === 'tool') {
      const text = String(last.content);
      return { generations: [{ message: new AIMessage(text), text }] };
    }
    return {
      generations: [
        {
          message: new AIMessage({
            content: '',
            tool_calls: [{ id: 'call_1', name: 'read_task_notes', args: {} }],
          }),
          text: '',
        },
      ],
    };
  }
}

describe('agents/tools/read-task-notes', () => {
  let dbDir: string;
  let fsDir: string;
  let store: WorkspaceStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'read-task-notes-tool-test-'));
    fsDir = mkdtempSync(join(tmpdir(), 'read-task-notes-fs-'));
    store = new WorkspaceStore(openDatabase(join(dbDir, 'test.db')));
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(fsDir, { recursive: true, force: true });
  });

  it('returns the current rendered Task File content from in-memory graph state [unit]', async () => {
    const task = store.createTask({ title: 'My Task' });
    const checkpointer = new SqliteSaver(new Database(join(fsDir, 'checkpoints.db')));
    const agent = createAgent({
      model: new ScriptedChatModel({}),
      tools: [makeReadTaskNotesTool(task.id, store)],
      middleware: [createTaskFileStateMiddleware()],
      checkpointer,
    });
    const config = { configurable: { thread_id: 'thread-1' } };
    await agent.updateState(config, {
      taskState: {
        goal: 'Ship it',
        previousTasks: [],
        notes: [['a note']],
        outcome: '',
        handoff: '',
      },
    });

    const result = await agent.invoke(
      { messages: [{ role: 'human', content: 'what have you done' }] },
      config,
    );
    const last = result.messages[result.messages.length - 1];

    expect(String(last.content)).to.include('My Task');
    expect(String(last.content)).to.include('Ship it');
    expect(String(last.content)).to.include('a note');
  });
});
