import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { REPLEnvironment, SENTINEL_FINAL, SENTINEL_NOT_FOUND } from "../../src/repl.js";
import { DEFAULT_CONFIG } from "../../src/types.js";
import type { ModelAdapter, ModelResponse, Message, Tool, RLMConfig } from "../../src/types.js";

// Stub adapter — sub-calls return a fixed string
const stubAdapter: ModelAdapter = {
  async complete(_messages: Message[], _tools: Tool[], _config: RLMConfig): Promise<ModelResponse> {
    return { content: "stub sub-call response", toolCalls: [], durationMs: 0 };
  },
};

function makeRepl(text: string): REPLEnvironment {
  return new REPLEnvironment(
    { text, source: "test" },
    { ...DEFAULT_CONFIG },
    stubAdapter
  );
}

const SAMPLE = [
  "line one: apple",
  "line two: banana",
  "line three: cherry",
  "line four: date",
  "line five: elderberry",
].join("\n");

describe("REPLEnvironment", () => {
  let repl: REPLEnvironment;

  beforeEach(() => {
    repl = makeRepl(SAMPLE);
  });

  describe("metadata", () => {
    it("exposes correct charCount and lineCount", () => {
      expect(repl.charCount).to.equal(SAMPLE.length);
      expect(repl.lineCount).to.equal(5);
    });

    it("exposes source label", () => {
      expect(repl.source).to.equal("test");
    });
  });

  describe("peek", () => {
    it("returns first N characters", async () => {
      const result = await repl.execute({ name: "peek", args: { chars: 10 } });
      expect(result).to.equal(SAMPLE.slice(0, 10));
    });

    it("defaults to 2000 chars", async () => {
      const result = await repl.execute({ name: "peek", args: {} });
      expect(result.length).to.be.at.most(SAMPLE.length);
    });
  });

  describe("grep", () => {
    it("returns matching lines with line numbers", async () => {
      const result = await repl.execute({ name: "grep", args: { pattern: "banana" } });
      expect(result).to.include("line 2:");
      expect(result).to.include("banana");
    });

    it("is case-insensitive", async () => {
      const result = await repl.execute({ name: "grep", args: { pattern: "BANANA" } });
      expect(result).to.include("banana");
    });

    it("returns no-match message when pattern not found", async () => {
      const result = await repl.execute({ name: "grep", args: { pattern: "zzz" } });
      expect(result).to.include("No matches found");
    });

    it("returns an error for invalid regex", async () => {
      const result = await repl.execute({ name: "grep", args: { pattern: "[invalid" } });
      expect(result).to.include("Invalid regex");
    });

    it("enforces maxResults and includes steering message", async () => {
      const bigText = Array.from({ length: 10 }, (_, i) => `hit line ${i + 1}`).join("\n");
      const bigRepl = makeRepl(bigText);
      const result = await bigRepl.execute({ name: "grep", args: { pattern: "hit", maxResults: 3 } });
      expect(result).to.include("Result limit reached");
      // Should have at most 3 result lines before the note
      const hitLines = result.split("\n").filter((l) => l.startsWith("line "));
      expect(hitLines.length).to.equal(3);
    });
  });

  describe("slice", () => {
    it("returns numbered lines in requested range", async () => {
      const result = await repl.execute({ name: "slice", args: { startLine: 2, endLine: 3 } });
      expect(result).to.include("2: line two: banana");
      expect(result).to.include("3: line three: cherry");
      expect(result).not.to.include("1: line one");
    });

    it("rejects ranges exceeding maxSliceLines", async () => {
      const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
      const bigRepl = makeRepl(manyLines);
      const result = await bigRepl.execute({ name: "slice", args: { startLine: 1, endLine: 300 } });
      expect(result).to.include("limit");
      expect(result).to.include("summarize");
    });
  });

  describe("summarize", () => {
    it("returns sub-adapter output", async () => {
      const result = await repl.execute({ name: "summarize", args: { startLine: 1, endLine: 3 } });
      expect(result).to.equal("stub sub-call response");
    });
  });

  describe("query", () => {
    it("returns sub-adapter output", async () => {
      const result = await repl.execute({
        name: "query",
        args: { question: "What fruit?", startLine: 1, endLine: 2 },
      });
      expect(result).to.equal("stub sub-call response");
    });
  });

  describe("not_found", () => {
    it("returns NOT_FOUND sentinel", async () => {
      const result = await repl.execute({ name: "not_found", args: { searched: "purple unicorn" } });
      expect(result).to.equal(SENTINEL_NOT_FOUND);
    });
  });

  describe("final_answer", () => {
    it("returns FINAL sentinel prefixed to content", async () => {
      const result = await repl.execute({ name: "final_answer", args: { content: "The answer is 42." } });
      expect(result).to.equal(SENTINEL_FINAL + "The answer is 42.");
    });
  });

  describe("unknown tool", () => {
    it("returns an error message listing valid tools", async () => {
      const result = await repl.execute({ name: "peep", args: {} });
      expect(result).to.include('Unknown tool: "peep"');
      expect(result).to.include("peek");
    });
  });
});
