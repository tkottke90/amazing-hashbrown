import { describe, it } from "mocha";
import { expect } from "chai";
import { RLMRunner } from "../../src/runner.js";
import type { ModelAdapter, ModelResponse, Message, Tool, RLMConfig, RLMCorpus } from "../../src/types.js";

// Scripted adapter: returns responses from a queue in order.
// Once the queue is exhausted, returns a plain-text fallback.
function scriptedAdapter(responses: Partial<ModelResponse>[]): ModelAdapter {
  let i = 0;
  return {
    async complete(): Promise<ModelResponse> {
      const base: ModelResponse = { content: "", rawContent: "", toolCalls: [], durationMs: 0 };
      if (i < responses.length) {
        return { ...base, ...responses[i++] };
      }
      return { ...base, content: "fallback answer" };
    },
  };
}

const corpus: RLMCorpus = {
  text: "line one: apple\nline two: banana\nline three: cherry",
  source: "test",
};

const baseConfig = {
  model: "test",
  maxIterations: 5,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
};

describe("RLMRunner termination paths", () => {
  it("exits via final_tool when model calls final_answer", async () => {
    const adapter = scriptedAdapter([
      {
        toolCalls: [{ name: "final_answer", args: { content: "The answer is banana." } }],
      },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run("What fruit is on line 2?", corpus);
    expect(result.terminationReason).to.equal("final_tool");
    expect(result.answer).to.equal("The answer is banana.");
    expect(result.found).to.be.true;
  });

  it("exits via not_found_tool when model calls not_found", async () => {
    const adapter = scriptedAdapter([
      {
        toolCalls: [{ name: "not_found", args: { searched: "purple unicorn" } }],
      },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run("Is there a purple unicorn?", corpus);
    expect(result.terminationReason).to.equal("not_found_tool");
    expect(result.found).to.be.false;
  });

  it("exits via no_tool_call when model responds with plain text", async () => {
    const adapter = scriptedAdapter([{ content: "Direct plain text answer.", toolCalls: [] }]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run("Quick question?", corpus);
    expect(result.terminationReason).to.equal("no_tool_call");
    expect(result.answer).to.equal("Direct plain text answer.");
  });

  it("exits via max_iterations and synthesizes", async () => {
    // Model always calls grep (will loop), then synthesis returns plain text
    let synthCall = false;
    const adapter: ModelAdapter = {
      async complete(_msgs: Message[], tools: Tool[], _cfg: RLMConfig): Promise<ModelResponse> {
        if (tools.length === 0) {
          synthCall = true;
          return { content: "Synthesized answer.", rawContent: "Synthesized answer.", toolCalls: [], durationMs: 0 };
        }
        return { content: "", rawContent: "", toolCalls: [{ name: "grep", args: { pattern: "apple" } }], durationMs: 0 };
      },
    };
    const runner = new RLMRunner(adapter, undefined, { ...baseConfig, maxIterations: 3 });
    const result = await runner.run("What is the answer?", corpus);
    expect(result.terminationReason).to.equal("max_iterations");
    expect(synthCall).to.be.true;
    expect(result.answer).to.equal("Synthesized answer.");
  });

  it("detects a repeated tool call and fires loop detection", async () => {
    // Same grep call twice in a row, then final_answer
    const adapter = scriptedAdapter([
      { toolCalls: [{ name: "grep", args: { pattern: "apple" } }] },
      { toolCalls: [{ name: "grep", args: { pattern: "apple" } }] }, // duplicate
      { toolCalls: [{ name: "final_answer", args: { content: "Found it." } }] },
    ]);
    const runner = new RLMRunner(adapter, undefined, { ...baseConfig, maxIterations: 10 });
    const result = await runner.run("Find apple.", corpus);
    expect(result.loopDetectionFired).to.be.true;
  });

  it("records tool calls in the trace", async () => {
    const adapter = scriptedAdapter([
      { toolCalls: [{ name: "peek", args: { chars: 100 } }] },
      { toolCalls: [{ name: "final_answer", args: { content: "Done." } }] },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    const result = await runner.run("What is this?", corpus);
    expect(result.toolCallTrace).to.have.length(1);
    expect(result.toolCallTrace[0]!.tool).to.equal("peek");
  });

  it("emits status signals via onStatus callback", async () => {
    const signals: string[] = [];
    const adapter = scriptedAdapter([
      { toolCalls: [{ name: "grep", args: { pattern: "banana" } }] },
      { toolCalls: [{ name: "final_answer", args: { content: "banana" } }] },
    ]);
    const runner = new RLMRunner(adapter, undefined, baseConfig);
    await runner.run("Find banana.", corpus, (s) => signals.push(s.phase));
    expect(signals).to.include("searching");
  });
});
