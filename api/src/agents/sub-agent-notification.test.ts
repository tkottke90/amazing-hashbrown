import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildNotificationMessage } from './sub-agent-notification.js';
import type { Task } from '../services/workspace-store.js';

// buildNotificationMessage is pure — no DB, no provider, no thread store —
// so these are plain unit tests, unlike deliverSubAgentCompletion's own
// end-to-end coverage (task-execution.test.ts's "sub-agent completion
// notification" describe block), which can only observe the completion
// marker's outcome field in this test environment, not this message text.
function makeTask(overrides: Partial<Task> = {}): Task {
  return { role: 'researcher', title: 'Investigate why the task failed', ...overrides } as Task;
}

describe('agents/sub-agent-notification — buildNotificationMessage [unit]', () => {
  it('reports a done outcome with its summary and no sibling note when none are running', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'done',
      'Found the root cause.',
      0,
      undefined,
    );
    expect(message).to.include('Sub-agent [researcher] completed');
    expect(message).to.include('Investigate why the task failed');
    expect(message).to.include('Summary: Found the root cause.');
    expect(message).to.include('No other sub-agents from this dispatch are still running.');
  });

  it('notes how many sibling sub-agents are still running', () => {
    const message = buildNotificationMessage(makeTask(), 'done', 'Found it.', 2, undefined);
    expect(message).to.include('2 sibling sub-agent(s) from this dispatch are still running.');
  });

  it('falls back to a placeholder when no summary was provided', () => {
    const message = buildNotificationMessage(makeTask(), 'failed', undefined, 0, undefined);
    expect(message).to.include('No summary was provided.');
  });

  it('renders a handed-off outcome as "handed off", not the raw status literal', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'handed_off',
      'Needs a human.',
      0,
      undefined,
    );
    expect(message).to.include('Sub-agent [researcher] handed off');
  });

  it('does not add the Loop-Guard Exhaustion line for an ordinary failed outcome', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'failed',
      'Hit an API error.',
      0,
      undefined,
    );
    expect(message).to.not.include('asked to stop investigating');
  });

  it('adds the distinguishing Loop-Guard Exhaustion line when failureReason is loop_guard_exhausted', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'failed',
      'Reached 25 LLM calls after already being asked to wrap up.',
      0,
      undefined,
      'loop_guard_exhausted',
    );
    expect(message).to.include('asked to stop investigating and deliver what it had');
    expect(message).to.include(
      'Summary: Reached 25 LLM calls after already being asked to wrap up.',
    );
  });

  it('does not add the distinguishing line for a different failureReason value', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'failed',
      'Ran out of steps.',
      0,
      undefined,
      'out_of_steps',
    );
    expect(message).to.not.include('asked to stop investigating');
  });

  it('includes a Thread line pointing at search_threads when a runThreadId is given', () => {
    const message = buildNotificationMessage(makeTask(), 'done', 'All done.', 0, 'run-thread-abc');
    expect(message).to.include('Thread: `run-thread-abc` (use search_threads to look into it)');
  });

  it('omits the Thread line entirely when no runThreadId is given', () => {
    const message = buildNotificationMessage(makeTask(), 'done', 'All done.', 0, undefined);
    expect(message).to.not.include('Thread:');
  });

  it('still reports outcome and summary normally regardless of the Thread line', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'failed',
      'Hit an error.',
      2,
      'run-thread-xyz',
    );
    expect(message).to.include('failed — goal: "Investigate why the task failed".');
    expect(message).to.include('Summary: Hit an error.');
    expect(message).to.include('2 sibling sub-agent(s) from this dispatch are still running.');
    expect(message).to.include('Thread: `run-thread-xyz`');
  });

  it('includes both the Loop-Guard line and the Thread line when both apply', () => {
    const message = buildNotificationMessage(
      makeTask(),
      'failed',
      'Ran out of budget.',
      0,
      'run-thread-both',
      'loop_guard_exhausted',
    );
    expect(message).to.include('asked to stop investigating and deliver what it had');
    expect(message).to.include('Thread: `run-thread-both` (use search_threads to look into it)');
  });
});
