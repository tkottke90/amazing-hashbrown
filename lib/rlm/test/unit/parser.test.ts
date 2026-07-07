import { describe, it } from "mocha";
import { expect } from "chai";
import { OllamaAdapter } from "../../src/adapters/ollama.js";

// We test the internal parsing logic by reaching the adapter's complete()
// method via a patched fetch — no real network calls.

type FetchLike = typeof globalThis.fetch;

function patchFetch(responseBody: unknown): () => void {
  const original = globalThis.fetch;
  (globalThis as Record<string, unknown>)["fetch"] = (async () => ({
    ok: true,
    json: async () => responseBody,
  })) as FetchLike;
  return () => {
    (globalThis as Record<string, unknown>)["fetch"] = original;
  };
}

describe("OllamaAdapter tool-call parsing", () => {
  const adapter = new OllamaAdapter({ baseUrl: "http://localhost:11434", model: "test" });
  const config = { model: "test", maxIterations: 10, maxResultTokens: 2000, maxSliceLines: 200, think: false };

  it("parses native structured tool_calls array (format 1)", async () => {
    const restore = patchFetch({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "grep", arguments: { pattern: "Marcus" } } }],
      },
    });
    try {
      const resp = await adapter.complete([], [], config);
      expect(resp.toolCalls).to.have.length(1);
      expect(resp.toolCalls[0]!.name).to.equal("grep");
      expect(resp.toolCalls[0]!.args).to.deep.equal({ pattern: "Marcus" });
    } finally {
      restore();
    }
  });

  it("parses <tool_call> XML escape format (format 2)", async () => {
    const restore = patchFetch({
      message: {
        role: "assistant",
        content: '<tool_call>{"name":"slice","arguments":{"startLine":10,"endLine":20}}</tool_call>',
      },
    });
    try {
      const resp = await adapter.complete([], [], config);
      expect(resp.toolCalls).to.have.length(1);
      expect(resp.toolCalls[0]!.name).to.equal("slice");
      expect(resp.toolCalls[0]!.args).to.deep.equal({ startLine: 10, endLine: 20 });
    } finally {
      restore();
    }
  });

  it("parses bare JSON array format (format 3)", async () => {
    const restore = patchFetch({
      message: {
        role: "assistant",
        content: '[{"name":"peek","arguments":{"chars":1000}}]',
      },
    });
    try {
      const resp = await adapter.complete([], [], config);
      expect(resp.toolCalls).to.have.length(1);
      expect(resp.toolCalls[0]!.name).to.equal("peek");
    } finally {
      restore();
    }
  });

  it("returns empty toolCalls for plain text response", async () => {
    const restore = patchFetch({
      message: { role: "assistant", content: "Here is my answer." },
    });
    try {
      const resp = await adapter.complete([], [], config);
      expect(resp.toolCalls).to.have.length(0);
      expect(resp.content).to.equal("Here is my answer.");
    } finally {
      restore();
    }
  });

  it("strips <think>...</think> blocks from content", async () => {
    const restore = patchFetch({
      message: {
        role: "assistant",
        content: "<think>internal reasoning here</think>The answer is banana.",
      },
    });
    try {
      const resp = await adapter.complete([], [], config);
      expect(resp.content).to.equal("The answer is banana.");
      expect(resp.content).not.to.include("<think>");
    } finally {
      restore();
    }
  });

  it("retries once on HTTP 5xx", async () => {
    let callCount = 0;
    const original = globalThis.fetch;
    (globalThis as Record<string, unknown>)["fetch"] = (async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 503, text: async () => "Service Unavailable" };
      }
      return {
        ok: true,
        json: async () => ({ message: { role: "assistant", content: "ok" } }),
      };
    }) as FetchLike;

    try {
      const resp = await adapter.complete([], [], config);
      expect(callCount).to.equal(2);
      expect(resp.content).to.equal("ok");
    } finally {
      (globalThis as Record<string, unknown>)["fetch"] = original;
    }
  });
});
