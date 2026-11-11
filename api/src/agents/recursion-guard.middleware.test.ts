import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import {
  createRecursionGuardMiddleware,
  StagnationLimitError,
} from './recursion-guard.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeState(aiCount: number): { messages: any[] } {
  return {
    messages: [
      new HumanMessage('start'),
      ...Array.from({ length: aiCount }, () => new AIMessage('working...')),
    ],
  };
}

// Builds a message list ending in `count` ToolMessage calls to `toolName`,
// each returning `output` — the shape computeStagnationStreak() walks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStagnantState(toolName: string, output: string, count: number): { messages: any[] } {
  const messages: unknown[] = [new HumanMessage('start')];
  for (let i = 0; i < count; i++) {
    messages.push(
      new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${i}`, name: toolName, args: {} }],
      }),
    );
    messages.push(new ToolMessage({ content: output, name: toolName, tool_call_id: `call_${i}` }));
  }
  return { messages };
}

// Builds a message list of `count` consecutive tool-call turns, each a
// different tool with a different output — no stagnation, only raw streak.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeVariedStreakState(count: number): { messages: any[] } {
  const messages: unknown[] = [new HumanMessage('start')];
  for (let i = 0; i < count; i++) {
    const toolName = `tool_${i}`;
    messages.push(
      new AIMessage({
        content: '',
        tool_calls: [{ id: `call_${i}`, name: toolName, args: {} }],
      }),
    );
    messages.push(
      new ToolMessage({ content: `result ${i}`, name: toolName, tool_call_id: `call_${i}` }),
    );
  }
  return { messages };
}

// Builds a message list of alternating tool-call turns across `toolOutputs`
// (tool name -> its own stable output), cycling through the list in order,
// repeated for `rounds` full cycles — the shape computeStagnationStreak's
// gap-tolerant scan must detect (issue #301).
function makeAlternatingState(
  toolOutputs: [string, string][],
  rounds: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { messages: any[] } {
  const messages: unknown[] = [new HumanMessage('start')];
  let callIndex = 0;
  for (let round = 0; round < rounds; round++) {
    for (const [toolName, output] of toolOutputs) {
      const id = `call_${callIndex++}`;
      messages.push(new AIMessage({ content: '', tool_calls: [{ id, name: toolName, args: {} }] }));
      messages.push(new ToolMessage({ content: output, name: toolName, tool_call_id: id }));
    }
  }
  return { messages };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callBeforeModel(guard: any, state: { messages: any[] }): Promise<unknown> {
  return guard.beforeModel(state, { context: {}, configurable: {} });
}

// Builds the step-count trigger's "already nudged once" shape: a Delivery
// Nudge HumanMessage tagged for `reason`, followed by `aiCount` more
// AIMessages — the state a run would be in the call after its first
// Delivery Nudge, for whichever `aiCount` the test wants to probe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDeliveryNudgedState(
  aiCount: number,
  reason: 'step_limit' | 'stagnation' | 'streak',
): { messages: any[] } {
  return {
    messages: [
      new HumanMessage('start'),
      new HumanMessage({
        content: 'nudge',
        additional_kwargs: { loopGuardKind: 'delivery-nudge', deliveryNudgeReason: reason },
      }),
      ...Array.from({ length: aiCount }, () => new AIMessage('working...')),
    ],
  };
}

// Builds the Reflection triggers' "already nudged once" shape: a Delivery
// Nudge HumanMessage tagged for `reason`, followed by `postNudgeCount` more
// tool calls all repeating the same tool/output — the Delivery Nudge acts
// as a genuine window boundary for computeStagnationStreak (unlike the
// older Stagnation Nudge), so the streak has to rebuild fully after it
// before Reflection can fire a second time. See GLOSSARY.md § Loop Guard.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNudgedThenStagnantState(
  toolName: string,
  output: string,
  reason: 'stagnation' | 'streak',
  postNudgeCount: number,
): { messages: any[] } {
  const messages: unknown[] = [
    new HumanMessage('start'),
    new HumanMessage({
      content: 'nudge',
      additional_kwargs: { loopGuardKind: 'delivery-nudge', deliveryNudgeReason: reason },
    }),
  ];
  for (let i = 0; i < postNudgeCount; i++) {
    messages.push(
      new AIMessage({ content: '', tool_calls: [{ id: `post_${i}`, name: toolName, args: {} }] }),
    );
    messages.push(new ToolMessage({ content: output, name: toolName, tool_call_id: `post_${i}` }));
  }
  return { messages };
}

// Same "already nudged once" shape as above, but for the raw-streak path:
// `postNudgeCount` consecutive tool calls, each a different tool with a
// different output, after the Delivery Nudge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNudgedThenVariedStreakState(
  reason: 'stagnation' | 'streak',
  postNudgeCount: number,
): { messages: any[] } {
  const messages: unknown[] = [
    new HumanMessage('start'),
    new HumanMessage({
      content: 'nudge',
      additional_kwargs: { loopGuardKind: 'delivery-nudge', deliveryNudgeReason: reason },
    }),
  ];
  for (let i = 0; i < postNudgeCount; i++) {
    const toolName = `post_tool_${i}`;
    messages.push(
      new AIMessage({ content: '', tool_calls: [{ id: `post_${i}`, name: toolName, args: {} }] }),
    );
    messages.push(
      new ToolMessage({ content: `post result ${i}`, name: toolName, tool_call_id: `post_${i}` }),
    );
  }
  return { messages };
}

describe('agents/recursion-guard.middleware', () => {
  describe('step-count check-in (existing behavior)', () => {
    it('returns undefined when no LLM calls have been made yet (completedSteps = 0)', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 10, warnThreshold: 0.5 }); // threshold = 5
      const result = await callBeforeModel(guard, makeState(0));
      expect(result).to.equal(undefined);
    });

    it('returns undefined when completedSteps is below the threshold', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 10, warnThreshold: 0.5 }); // threshold = 5
      const result = await callBeforeModel(guard, makeState(4));
      expect(result).to.equal(undefined);
    });

    it('fires interrupt (throws) when completedSteps exactly equals the threshold', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 10, warnThreshold: 0.5 }); // threshold = 5
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(5));
      } catch {
        threw = true;
      }
      expect(threw, 'guard should throw NodeInterrupt when threshold is reached').to.equal(true);
    });

    it('does not fire at completedSteps one below the threshold', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 100, warnThreshold: 0.75 }); // threshold = 75
      const result = await callBeforeModel(guard, makeState(74));
      expect(result).to.equal(undefined);
    });

    it('fires at the threshold (75 with default settings)', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 100, warnThreshold: 0.75 }); // threshold = 75
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(75));
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('does not fire between multiples of the threshold (76 after firing at 75)', async () => {
      // The modulo design fires at 75, 150, 225 — not at 76, 77, etc.
      // This gives the agent a fresh interval after each resume.
      const guard = createRecursionGuardMiddleware({ recursionLimit: 100, warnThreshold: 0.75 }); // threshold = 75
      const result = await callBeforeModel(guard, makeState(76));
      expect(result).to.equal(undefined);
    });

    it('fires again at the next multiple of the threshold (150)', async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 100, warnThreshold: 0.75 }); // threshold = 75
      let threw = false;
      try {
        await callBeforeModel(guard, makeState(150));
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('threshold is floor(recursionLimit * warnThreshold)', () => {
      expect(Math.floor(100 * 0.75)).to.equal(75);
      expect(Math.floor(8 * 0.5)).to.equal(4);
      expect(Math.floor(10 * 0.1)).to.equal(1);
    });

    it('step-count exhaustion throws StagnationLimitError (reason: step_limit) in throw mode', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 10,
        warnThreshold: 0.5, // threshold = 5
        escalationMode: 'throw',
      });
      let caught: unknown;
      try {
        await callBeforeModel(guard, makeState(5));
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(StagnationLimitError);
      expect((caught as StagnationLimitError).reason).to.equal('step_limit');
    });

    it("loopGuard omitted entirely reproduces today's step-count-only behavior (no crash on a non-threshold step)", async () => {
      const guard = createRecursionGuardMiddleware({ recursionLimit: 100, warnThreshold: 0.75 });
      const result = await callBeforeModel(guard, makeState(10));
      expect(result).to.equal(undefined);
    });
  });

  describe('stagnation detection', () => {
    const loopGuard = {
      enabled: true,
      stagnationNudgeThreshold: 3,
      stagnationReflectionThreshold: 5,
      streakReflectionThreshold: 10,
    };

    it('does nothing below the nudge threshold', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const result = await callBeforeModel(
        guard,
        makeStagnantState('shell_exec', 'same output', 2),
      );
      expect(result).to.equal(undefined);
    });

    it('injects a nudge HumanMessage exactly at the nudge threshold', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const result = (await callBeforeModel(
        guard,
        makeStagnantState('shell_exec', 'same output', 3),
      )) as { messages: HumanMessage[] } | undefined;
      expect(result).to.not.equal(undefined);
      expect(result!.messages).to.have.lengthOf(1);
      expect(result!.messages[0]).to.be.instanceOf(HumanMessage);
      expect(String(result!.messages[0].content)).to.include('shell_exec');
      expect(String(result!.messages[0].content)).to.include('3 times');
    });

    it('resets the streak when the tool name differs', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const base = makeStagnantState('shell_exec', 'same output', 2);
      base.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_x', name: 'wiki_search', args: {} }],
        }),
        new ToolMessage({ content: 'same output', name: 'wiki_search', tool_call_id: 'call_x' }),
      );
      const result = await callBeforeModel(guard, base);
      expect(result).to.equal(undefined);
    });

    it('resets the streak when the output differs', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const base = makeStagnantState('shell_exec', 'same output', 2);
      base.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_x', name: 'shell_exec', args: {} }],
        }),
        new ToolMessage({
          content: 'different output',
          name: 'shell_exec',
          tool_call_id: 'call_x',
        }),
      );
      const result = await callBeforeModel(guard, base);
      expect(result).to.equal(undefined);
    });

    it('still counts as stagnant across a timestamp-only output difference', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const messages: unknown[] = [new HumanMessage('start')];
      const timestamps = [
        '2026-10-05T18:05:37.245Z',
        '2026-10-05T18:05:40.474Z',
        '2026-10-05T18:05:43.001Z',
      ];
      for (const [i, ts] of timestamps.entries()) {
        messages.push(
          new AIMessage({
            content: '',
            tool_calls: [{ id: `call_${i}`, name: 'shell_exec', args: {} }],
          }),
          new ToolMessage({
            content: `no matches (checked at ${ts})`,
            name: 'shell_exec',
            tool_call_id: `call_${i}`,
          }),
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await callBeforeModel(guard, { messages } as any);
      expect(result).to.not.equal(undefined);
    });

    it('detects stagnation across alternating tool calls and injects the nudge at the threshold (issue #301)', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const state = makeAlternatingState(
        [
          ['git_status', 'clean'],
          ['wiki_locate', 'page not found'],
        ],
        2,
      );
      state.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_extra', name: 'git_status', args: {} }],
        }),
        new ToolMessage({ content: 'clean', name: 'git_status', tool_call_id: 'call_extra' }),
      );
      const result = (await callBeforeModel(guard, state)) as
        | { messages: HumanMessage[] }
        | undefined;
      expect(result).to.not.equal(undefined);
      expect(result!.messages).to.have.lengthOf(1);
      expect(result!.messages[0]).to.be.instanceOf(HumanMessage);
      const content = String(result!.messages[0].content);
      expect(content).to.include('git_status');
      expect(content).to.include('3 times');
      expect(content).to.include('recently');
      expect(content).to.not.include('in a row');
    });

    it('does not trip stagnation when alternating tools each return genuinely different output every call', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const messages: unknown[] = [new HumanMessage('start')];
      const toolNames = ['git_status', 'wiki_locate'];
      for (let i = 0; i < 8; i++) {
        const toolName = toolNames[i % 2];
        messages.push(
          new AIMessage({
            content: '',
            tool_calls: [{ id: `call_${i}`, name: toolName, args: {} }],
          }),
          new ToolMessage({ content: `result-${i}`, name: toolName, tool_call_id: `call_${i}` }),
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await callBeforeModel(guard, { messages } as any);
      expect(result).to.equal(undefined);
    });

    it('resets the gap-tolerant scan at a plain-text AIMessage between two matching tool calls', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const base = makeStagnantState('shell_exec', 'same output', 2);
      base.messages.push(new AIMessage('a plain-text reply'));
      base.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_x', name: 'shell_exec', args: {} }],
        }),
        new ToolMessage({ content: 'same output', name: 'shell_exec', tool_call_id: 'call_x' }),
      );
      const result = await callBeforeModel(guard, base);
      expect(result).to.equal(undefined);
    });

    it('resets the gap-tolerant scan at a new HumanMessage between two matching tool calls', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const base = makeStagnantState('shell_exec', 'same output', 2);
      base.messages.push(new HumanMessage('a new instruction'));
      base.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_x', name: 'shell_exec', args: {} }],
        }),
        new ToolMessage({ content: 'same output', name: 'shell_exec', tool_call_id: 'call_x' }),
      );
      const result = await callBeforeModel(guard, base);
      expect(result).to.equal(undefined);
    });

    it("does not re-fire the nudge for an unrelated tool once a different tool's count sits flat at the threshold", async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      // git_status crosses the nudge threshold (3) on this sequence.
      const state = makeAlternatingState(
        [
          ['git_status', 'clean'],
          ['wiki_locate', 'page not found'],
        ],
        2,
      );
      state.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_extra_1', name: 'git_status', args: {} }],
        }),
        new ToolMessage({ content: 'clean', name: 'git_status', tool_call_id: 'call_extra_1' }),
      );
      const firstResult = (await callBeforeModel(guard, state)) as
        | { messages: HumanMessage[] }
        | undefined;
      expect(firstResult, 'git_status should trip the nudge here').to.not.equal(undefined);

      // A call to a brand-new third tool: its own count is 1 (anchoring to
      // only the most recently called tool, not a max across every tool
      // seen, is exactly what keeps this from re-firing just because
      // git_status's count — still 3 — happens to still be "at" the
      // threshold somewhere earlier in the list).
      state.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_extra_2', name: 'ls_output', args: {} }],
        }),
        new ToolMessage({ content: 'empty', name: 'ls_output', tool_call_id: 'call_extra_2' }),
      );
      const secondResult = await callBeforeModel(guard, state);
      expect(
        secondResult,
        "the nudge should not re-fire for an unrelated tool while git_status's count sits unchanged at the threshold",
      ).to.equal(undefined);

      // wiki_locate already has 2 occurrences from the alternating sequence
      // above; one more is its 3rd — a genuine new crossing, so the nudge
      // should fire again, this time for wiki_locate.
      state.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_extra_3', name: 'wiki_locate', args: {} }],
        }),
        new ToolMessage({
          content: 'page not found',
          name: 'wiki_locate',
          tool_call_id: 'call_extra_3',
        }),
      );
      const thirdResult = (await callBeforeModel(guard, state)) as
        | { messages: HumanMessage[] }
        | undefined;
      expect(thirdResult, 'wiki_locate should trip its own nudge now').to.not.equal(undefined);
      const content = String(thirdResult!.messages[0].content);
      expect(content).to.include('wiki_locate');
      expect(content).to.include('3 times');
    });

    it("passes through the loop guard's own nudge message without resetting the gap-tolerant scan", async () => {
      // Simulates what a real run looks like once a nudge has already fired
      // and been appended to state (see loop-guard.integration.test.ts for
      // the end-to-end version) — the injected nudge HumanMessage must not
      // act as a window boundary, or stagnation could never reach the
      // reflection threshold once a model ignores the nudge and keeps going.
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const base = makeStagnantState('shell_exec', 'same output', 2);
      base.messages.push(
        new HumanMessage({
          content: "You've called `shell_exec` 2 times recently...",
          additional_kwargs: { loopGuardKind: 'nudge' },
        }),
      );
      base.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_x', name: 'shell_exec', args: {} }],
        }),
        new ToolMessage({ content: 'same output', name: 'shell_exec', tool_call_id: 'call_x' }),
      );
      // Streak is 3 (2 matches before the nudge + 1 after it) — the nudge
      // firing here (nudgeThreshold is also 3) proves the scan counted
      // straight through the tagged nudge message rather than stopping at
      // it; a reset would leave the streak at 1 and this would be undefined.
      const result = await callBeforeModel(guard, base);
      expect(result, 'the scan should count through the nudge, not reset at it').to.not.equal(
        undefined,
      );
    });
  });

  describe('reflection trigger (stubbed evaluateLoopProgress — no real model call)', () => {
    const loopGuard = {
      enabled: true,
      stagnationNudgeThreshold: 3,
      stagnationReflectionThreshold: 5,
      streakReflectionThreshold: 10,
    };

    it('reaches reflection via the alternating-tool stagnation count, not just the raw streak (issue #301)', async () => {
      let called: unknown;
      const stub = async (params: unknown) => {
        called = params;
        return { converging: true, summary: 'making progress' };
      };
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
      });
      // git_status reaches its 5th occurrence (stagnationReflectionThreshold)
      // on the 9th call overall, alternating with wiki_locate the whole way.
      const state = makeAlternatingState(
        [
          ['git_status', 'clean'],
          ['wiki_locate', 'page not found'],
        ],
        4,
      );
      state.messages.push(
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call_extra', name: 'git_status', args: {} }],
        }),
        new ToolMessage({ content: 'clean', name: 'git_status', tool_call_id: 'call_extra' }),
      );
      await callBeforeModel(guard, state);
      expect(called, 'evaluateLoopProgress should have been called').to.not.equal(undefined);
      expect((called as { reason: string }).reason).to.equal('stagnation');
    });

    it('injects guidance and does not escalate when the stub reports converging: true', async () => {
      let called: unknown;
      const stub = async (params: unknown) => {
        called = params;
        return { converging: true, summary: 'making progress', guidance: 'keep going, try X next' };
      };
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
      });
      const result = (await callBeforeModel(
        guard,
        makeStagnantState('shell_exec', 'same output', 5),
      )) as { messages: HumanMessage[] } | undefined;
      expect(called, 'evaluateLoopProgress should have been called').to.not.equal(undefined);
      expect((called as { reason: string }).reason).to.equal('stagnation');
      expect(result).to.not.equal(undefined);
      expect(String(result!.messages[0].content)).to.equal('keep going, try X next');
    });

    it('reaches reflection via the raw streak path, independent of any repeats', async () => {
      let called: unknown;
      const stub = async (params: unknown) => {
        called = params;
        return { converging: true, summary: 'still exploring, making progress' };
      };
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
      });
      await callBeforeModel(guard, makeVariedStreakState(10));
      expect(
        called,
        'evaluateLoopProgress should have been called via the streak path',
      ).to.not.equal(undefined);
      expect((called as { reason: string }).reason).to.equal('streak');
    });

    it('passes the closure-bound taskId through to evaluateLoopProgress when configured', async () => {
      let called: unknown;
      const stub = async (params: unknown) => {
        called = params;
        return { converging: true, summary: 'making progress' };
      };
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
        taskId: 'task-abc',
      });
      await callBeforeModel(guard, makeStagnantState('shell_exec', 'same output', 5));
      expect((called as { taskId?: string }).taskId).to.equal('task-abc');
    });

    it('leaves taskId undefined when not configured (chat/workspace-chat/sub-agent runs)', async () => {
      let called: unknown;
      const stub = async (params: unknown) => {
        called = params;
        return { converging: true, summary: 'making progress' };
      };
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
      });
      await callBeforeModel(guard, makeStagnantState('shell_exec', 'same output', 5));
      expect((called as { taskId?: string }).taskId).to.equal(undefined);
    });

    it('escalates (interrupt mode) when the stub reports converging: false', async () => {
      const stub = async () => ({ converging: false, summary: 'not converging, stuck' });
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        evaluateLoopProgress: stub,
      });
      let threw = false;
      try {
        await callBeforeModel(guard, makeStagnantState('shell_exec', 'same output', 5));
      } catch {
        threw = true;
      }
      expect(threw, 'a non-converging reflection should escalate via interrupt()').to.equal(true);
    });

    it('escalates by throwing StagnationLimitError when the stub reports converging: false (throw mode)', async () => {
      const stub = async () => ({ converging: false, summary: 'not converging, stuck' });
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
        escalationMode: 'throw',
        evaluateLoopProgress: stub,
      });
      let caught: unknown;
      try {
        await callBeforeModel(guard, makeStagnantState('shell_exec', 'same output', 5));
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(StagnationLimitError);
      expect((caught as StagnationLimitError).reason).to.equal('stagnation');
      expect((caught as StagnationLimitError).summary).to.equal('not converging, stuck');
    });
  });

  describe('raw streak detection', () => {
    const loopGuard = {
      enabled: true,
      stagnationNudgeThreshold: 3,
      stagnationReflectionThreshold: 5,
      streakReflectionThreshold: 10,
    };

    it('does nothing below the streak-reflection threshold', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const result = await callBeforeModel(guard, makeVariedStreakState(9));
      expect(result).to.equal(undefined);
    });

    it('resets the raw streak on a plain-text AIMessage (no tool call)', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const state = makeVariedStreakState(9);
      state.messages.push(new AIMessage('here is a plain reply'));
      const result = await callBeforeModel(guard, state);
      expect(result).to.equal(undefined);
    });

    it('resets the raw streak on a new HumanMessage', async () => {
      const guard = createRecursionGuardMiddleware({
        recursionLimit: 1000,
        warnThreshold: 0.99,
        loopGuard,
      });
      const state = makeVariedStreakState(9);
      state.messages.push(new HumanMessage('a new question'));
      const result = await callBeforeModel(guard, state);
      expect(result).to.equal(undefined);
    });
  });

  describe('Delivery Nudge (throw mode — issue #411, ADR-0062)', () => {
    describe('step-count trigger', () => {
      it('injects a Delivery Nudge instead of throwing on the first crossing', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75, // threshold = 18
          escalationMode: 'throw',
        });
        const result = (await callBeforeModel(guard, makeState(18))) as
          | { messages: HumanMessage[] }
          | undefined;
        expect(result).to.not.equal(undefined);
        expect(result!.messages).to.have.lengthOf(1);
        expect(result!.messages[0]).to.be.instanceOf(HumanMessage);
        expect(result!.messages[0].additional_kwargs?.loopGuardKind).to.equal('delivery-nudge');
        expect(result!.messages[0].additional_kwargs?.deliveryNudgeReason).to.equal('step_limit');
      });

      it('does nothing once nudged but still below the hard ceiling (does not re-nudge or throw)', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75,
          escalationMode: 'throw',
        });
        const result = await callBeforeModel(guard, makeDeliveryNudgedState(20, 'step_limit'));
        expect(result).to.equal(undefined);
      });

      it('throws StagnationLimitError at the hard ceiling when hasDelivered reports false', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75,
          escalationMode: 'throw',
          hasDelivered: () => false,
        });
        let caught: unknown;
        try {
          await callBeforeModel(guard, makeDeliveryNudgedState(25, 'step_limit'));
        } catch (err) {
          caught = err;
        }
        expect(caught).to.be.instanceOf(StagnationLimitError);
        expect((caught as StagnationLimitError).reason).to.equal('step_limit');
      });

      it('does not throw at the hard ceiling when hasDelivered reports true', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75,
          escalationMode: 'throw',
          hasDelivered: () => true,
        });
        const result = await callBeforeModel(guard, makeDeliveryNudgedState(25, 'step_limit'));
        expect(result).to.equal(undefined);
      });

      it('keeps throwing past the ceiling too, not only exactly at it', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75,
          escalationMode: 'throw',
          hasDelivered: () => false,
        });
        let caught: unknown;
        try {
          await callBeforeModel(guard, makeDeliveryNudgedState(27, 'step_limit'));
        } catch (err) {
          caught = err;
        }
        expect(caught).to.be.instanceOf(StagnationLimitError);
      });

      it('treats an omitted hasDelivered as "not delivered" (defensive default)', async () => {
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 25,
          warnThreshold: 0.75,
          escalationMode: 'throw',
        });
        let caught: unknown;
        try {
          await callBeforeModel(guard, makeDeliveryNudgedState(25, 'step_limit'));
        } catch (err) {
          caught = err;
        }
        expect(caught).to.be.instanceOf(StagnationLimitError);
      });

      it("'interrupt' mode is completely unaffected — still escalates at the threshold, never nudges", async () => {
        const guard = createRecursionGuardMiddleware({ recursionLimit: 25, warnThreshold: 0.75 });
        let threw = false;
        try {
          await callBeforeModel(guard, makeState(18));
        } catch {
          threw = true;
        }
        expect(threw, 'interrupt mode should escalate at the threshold, not nudge').to.equal(true);
      });
    });

    describe('reflection trigger (stagnation)', () => {
      const loopGuard = {
        enabled: true,
        stagnationNudgeThreshold: 3,
        stagnationReflectionThreshold: 5,
        streakReflectionThreshold: 10,
      };

      it('injects a Delivery Nudge tagged "stagnation" on the first non-converging verdict', async () => {
        const stub = async () => ({ converging: false, summary: 'not converging, stuck' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
        });
        const result = (await callBeforeModel(
          guard,
          makeStagnantState('shell_exec', 'same output', 5),
        )) as { messages: HumanMessage[] } | undefined;
        expect(result).to.not.equal(undefined);
        expect(result!.messages[0].additional_kwargs?.loopGuardKind).to.equal('delivery-nudge');
        expect(result!.messages[0].additional_kwargs?.deliveryNudgeReason).to.equal('stagnation');
      });

      it('never nudges when the stub reports converging: true (unaffected by this feature)', async () => {
        const stub = async () => ({ converging: true, summary: 'making progress' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
        });
        const result = (await callBeforeModel(
          guard,
          makeStagnantState('shell_exec', 'same output', 5),
        )) as { messages: HumanMessage[] } | undefined;
        expect(result).to.not.equal(undefined);
        expect(result!.messages[0].additional_kwargs?.loopGuardKind).to.not.equal('delivery-nudge');
      });

      it('throws StagnationLimitError once the streak rebuilds to the threshold again after the nudge, with nothing delivered', async () => {
        const stub = async () => ({ converging: false, summary: 'still not converging' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
          hasDelivered: () => false,
        });
        const state = makeNudgedThenStagnantState('shell_exec', 'same output', 'stagnation', 5);
        let caught: unknown;
        try {
          await callBeforeModel(guard, state);
        } catch (err) {
          caught = err;
        }
        expect(caught).to.be.instanceOf(StagnationLimitError);
        expect((caught as StagnationLimitError).reason).to.equal('stagnation');
      });

      it('does not throw a second time when hasDelivered reports true', async () => {
        const stub = async () => ({ converging: false, summary: 'still not converging' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
          hasDelivered: () => true,
        });
        const state = makeNudgedThenStagnantState('shell_exec', 'same output', 'stagnation', 5);
        const result = await callBeforeModel(guard, state);
        expect(result).to.equal(undefined);
      });
    });

    describe('reflection trigger (raw streak)', () => {
      const loopGuard = {
        enabled: true,
        stagnationNudgeThreshold: 3,
        stagnationReflectionThreshold: 5,
        streakReflectionThreshold: 10,
      };

      it('injects a Delivery Nudge tagged "streak" on the first non-converging verdict', async () => {
        const stub = async () => ({ converging: false, summary: 'not converging, stuck' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
        });
        const result = (await callBeforeModel(guard, makeVariedStreakState(10))) as
          | { messages: HumanMessage[] }
          | undefined;
        expect(result).to.not.equal(undefined);
        expect(result!.messages[0].additional_kwargs?.deliveryNudgeReason).to.equal('streak');
      });

      it('throws StagnationLimitError once the streak rebuilds to the threshold again after the nudge, with nothing delivered', async () => {
        const stub = async () => ({ converging: false, summary: 'still not converging' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
          hasDelivered: () => false,
        });
        const state = makeNudgedThenVariedStreakState('streak', 10);
        let caught: unknown;
        try {
          await callBeforeModel(guard, state);
        } catch (err) {
          caught = err;
        }
        expect(caught).to.be.instanceOf(StagnationLimitError);
        expect((caught as StagnationLimitError).reason).to.equal('streak');
      });

      it('does not throw a second time when hasDelivered reports true', async () => {
        const stub = async () => ({ converging: false, summary: 'still not converging' });
        const guard = createRecursionGuardMiddleware({
          recursionLimit: 1000,
          warnThreshold: 0.99,
          loopGuard,
          escalationMode: 'throw',
          evaluateLoopProgress: stub,
          hasDelivered: () => true,
        });
        const state = makeNudgedThenVariedStreakState('streak', 10);
        const result = await callBeforeModel(guard, state);
        expect(result).to.equal(undefined);
      });
    });
  });
});
