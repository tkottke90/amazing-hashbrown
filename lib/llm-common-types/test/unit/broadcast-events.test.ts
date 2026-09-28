import { describe, it } from 'mocha';
import { expect } from 'chai';
import { AppBroadcastEventSchema } from '../../src/chat/broadcast-events.js';

describe('chat/AppBroadcastEventSchema — task_plan_updated', () => {
  it('accepts a task_plan_updated event carrying the full updated plan [unit]', () => {
    const event = {
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [
        { step: 'Scaffold the route', done: true },
        { step: 'Add tests', done: false },
      ],
    };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('accepts an empty plan, so clearing every step is still broadcastable [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [],
    });
    expect(parsed.success).to.equal(true);
  });

  it('rejects a plan step missing its done flag, so the UI never renders an ambiguous checkbox [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [{ step: 'Add tests' }],
    });
    expect(parsed.success).to.equal(false);
  });

  it('rejects an event with no taskId, since the UI has no task to patch [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({ type: 'task_plan_updated', plan: [] });
    expect(parsed.success).to.equal(false);
  });
});

describe('chat/AppBroadcastEventSchema — thread turn lifecycle', () => {
  it('accepts a thread_turn_started event from a wake-up, so a client can mark the thread busy [unit]', () => {
    const event = { type: 'thread_turn_started', threadId: 't-1', source: 'wakeup' };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('rejects a thread_turn_started event with an unknown source, since the UI labels the busy state by source [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'thread_turn_started',
      threadId: 't-1',
      source: 'cron',
    });
    expect(parsed.success).to.equal(false);
  });

  it('accepts a thread_turn_completed event carrying only the thread id [unit]', () => {
    const event = { type: 'thread_turn_completed', threadId: 't-1' };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('rejects a thread_turn_completed event with no threadId, since there is nothing to re-hydrate [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({ type: 'thread_turn_completed' });
    expect(parsed.success).to.equal(false);
  });
});

describe('chat/AppBroadcastEventSchema — after_agent_state', () => {
  it('accepts a running state, so the thread list can show the spinner live [unit]', () => {
    const event = { type: 'after_agent_state', threadId: 't-1', state: { status: 'running' } };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('accepts a done state carrying outcome and finishedAt, which the indicator dedups its flash on [unit]', () => {
    const event = {
      type: 'after_agent_state',
      threadId: 't-1',
      state: { status: 'done', outcome: 'identified', finishedAt: '2026-09-28T00:00:00.000Z' },
    };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('rejects a done state with no outcome, since the indicator has no icon to pick [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'after_agent_state',
      threadId: 't-1',
      state: { status: 'done', finishedAt: '2026-09-28T00:00:00.000Z' },
    });
    expect(parsed.success).to.equal(false);
  });

  it('rejects an unknown status, so a malformed event never reaches the thread list [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'after_agent_state',
      threadId: 't-1',
      state: { status: 'queued' },
    });
    expect(parsed.success).to.equal(false);
  });
});
