import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { loadTaskState } from '../../services/task-file.js';
import { createTaskFileStateMiddleware } from '../task-file-state.middleware.js';
import { makeWriteTaskNoteTool } from './write-task-note.tool.js';

// Drives a real tool call deterministically through a real createAgent()
// graph, without a live LLM — same pattern as thread-fork.test.ts's
// ScriptedChatModel. The first human turn triggers write_task_note; the
// next (post-tool) turn ends with plain text.
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
      const text = 'Noted.';
      return { generations: [{ message: new AIMessage(text), text }] };
    }
    return {
      generations: [
        {
          message: new AIMessage({
            content: '',
            tool_calls: [
              { id: 'call_1', name: 'write_task_note', args: { note: 'Found the bug' } },
            ],
          }),
          text: '',
        },
      ],
    };
  }
}

describe('agents/tools/write-task-note', () => {
  let dbDir: string;
  let store: WorkspaceStore;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'write-task-note-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dbDir, 'test.db')));
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  describe('a real agent run — confirms the tool-returned Command mechanism', () => {
    let fsDir: string;

    before(() => {
      fsDir = mkdtempSync(join(tmpdir(), 'write-task-note-fs-'));
    });

    after(() => {
      rmSync(fsDir, { recursive: true, force: true });
    });

    it('a tool returning Command({ update }) directly updates the graph state, read back via agent.getState [orchestration]', async () => {
      const task = store.createTask({ title: 'Investigate flaky test' });
      const filePath = join(fsDir, 'tasks', `t-${task.id}.md`);

      const checkpointDb = new Database(join(fsDir, 'checkpoints.db'));
      const checkpointer = new SqliteSaver(checkpointDb);
      const agent = createAgent({
        model: new ScriptedChatModel({}),
        tools: [makeWriteTaskNoteTool(task.id, filePath, store)],
        middleware: [createTaskFileStateMiddleware()],
        checkpointer,
      });
      const config = { configurable: { thread_id: 'thread-1' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'please note this' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.taskState.notes).to.deep.equal([['Found the bug']]);

      const { state: fileState } = await loadTaskState(filePath);
      expect(fileState.notes).to.deep.equal([['Found the bug']]);
    });
  });

  describe('note accumulation (direct tool invocation)', () => {
    let fsDir: string;

    beforeEach(() => {
      fsDir = mkdtempSync(join(tmpdir(), 'write-task-note-direct-'));
    });

    afterEach(() => {
      rmSync(fsDir, { recursive: true, force: true });
    });

    it('appends to the current (last) run segment, scoped to this taskId [unit]', async () => {
      const task = store.createTask({ title: 'T' });
      const filePath = join(fsDir, `t-${task.id}.md`);
      const checkpointDb = new Database(join(fsDir, 'checkpoints.db'));
      const checkpointer = new SqliteSaver(checkpointDb);
      const agent = createAgent({
        model: new ScriptedChatModel({}),
        tools: [makeWriteTaskNoteTool(task.id, filePath, store)],
        middleware: [createTaskFileStateMiddleware()],
        checkpointer,
      });
      const config = { configurable: { thread_id: 'thread-2' } };
      await agent.updateState(config, {
        taskState: { goal: '', previousTasks: [], notes: [['first']], outcome: '', handoff: '' },
      });

      await agent.invoke({ messages: [{ role: 'human', content: 'please note this' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.taskState.notes).to.deep.equal([['first', 'Found the bug']]);
    });

    it('does not throw when the Task File write fails [unit]', async () => {
      const task = store.createTask({ title: 'T' });
      // A plain file sitting where a directory component needs to be —
      // mkdir(dirname(filePath), { recursive: true }) fails against this,
      // so writeTaskFile rejects.
      const { writeFileSync } = await import('node:fs');
      const blocker = join(fsDir, 'blocker-file');
      writeFileSync(blocker, 'not a directory', 'utf8');
      const badPath = join(blocker, 'sub', 'file.md');

      const checkpointDb = new Database(join(fsDir, 'checkpoints.db'));
      const checkpointer = new SqliteSaver(checkpointDb);
      const agent = createAgent({
        model: new ScriptedChatModel({}),
        tools: [makeWriteTaskNoteTool(task.id, badPath, store)],
        middleware: [createTaskFileStateMiddleware()],
        checkpointer,
      });
      const config = { configurable: { thread_id: 'thread-3' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'please note this' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.taskState.notes).to.deep.equal([['Found the bug']]);
    });
  });
});
