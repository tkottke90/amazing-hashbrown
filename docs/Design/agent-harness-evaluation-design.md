# Agent Harness Evaluation Design

## The Challenge

Modern agent harnesses increasingly let users **bring their own LLM** — a local model served through Ollama, LM Studio, Lemonade, or similar runtimes — rather than locking them into a single hosted provider. This is a major usability win, but it creates a new problem: **not every model that a user points at the harness will actually work well inside it.**

The failure modes aren't about general intelligence. A model can reason well and still break the harness because it:

- Doesn't reliably emit tool calls in the harness's expected format (JSON schema, XML, or another structured contract)
- Loses track of a multi-step tool-calling sequence (call → result → next call)
- Degrades when fed realistic, verbose tool-output payloads that eat into its effective context window
- Fails to hold the harness's system-prompt structure and instruction priority under pressure
- Recovers poorly — or not at all — from a malformed or error tool result
- Behaves inconsistently once quantized (a near-universal condition for locally-run models)

This document outlines the design challenge — **building a built-in tool that lets users measure whether a specific model will work well with the agent harness** — and evaluates whether existing LLM/agent benchmarks solve this problem, before recommending a concrete approach.

---

## LLM Benchmarks: What Exists, and Why They Fall Short Here

Over the past two years, a substantial ecosystem of benchmarks has emerged to evaluate LLM agentic capability. Broadly, they fall into three families:

### General-purpose agent benchmarks
- **GAIA / GAIA2** — real-world assistant questions requiring tools, browsing, and multi-step reasoning; GAIA2 extends this to dynamic, asynchronous environments.
- **SWE-bench (Verified)** — real GitHub bug-fix tasks; a proxy for planning, tool use, and self-correction.
- **OSWorld** — computer-use tasks on a real desktop environment.
- **WebArena** — multi-step browser tasks across e-commerce, forums, and CMS platforms.
- **Terminal-Bench** — autonomous shell/terminal task completion.
- **tau-bench (τ-bench / τ²-bench)** — tool-agent-user interactions with policy adherence, modeled on customer-service workflows.
- **METR HCAST / Time Horizons** — measures the longest task (in human-equivalent minutes) a model can complete autonomously 50% of the time; tracks capability trajectory over time rather than a single score.

### Instruction-hierarchy and prompt-injection benchmarks
- **IHEval, IHChallenge, HieraBench, ManyIH-Bench** — test whether a model correctly prioritizes system/developer instructions over user or tool-output content when they conflict.
- **System IFEval, TensorTrust, OpenPromptInjection, MMLU-PI** — test robustness against adversarial or injected instructions specifically, often via tool outputs or retrieved documents.
- **AgentDojo, InjecAgent** — agent-specific security benchmarks that test whether a tool-using agent resists prompt injection while still completing its legitimate task.

### Why none of these are the right fit for harness compatibility

| Benchmark family | What it measures | Why it doesn't answer "will this model work in my harness?" |
|---|---|---|
| GAIA, SWE-bench, OSWorld, WebArena, Terminal-Bench | General task-solving capability with generous, benchmark-specific scaffolding | Tests the model's reasoning ceiling, not compatibility with *your* tool schema, prompt format, or runtime constraints. A model can score well here and still emit malformed tool calls in your harness. |
| tau-bench | Tool use combined with policy adherence, but in a fixed customer-service domain | Domain-specific; a strong score doesn't transfer to arbitrary harness tools and workflows. |
| METR Time Horizons | Capability trajectory over long, complex tasks | Useful as a general capability signal, but says nothing about format compliance, context handling under your specific payload sizes, or your harness's tool-call protocol. |
| IH / prompt-injection benchmarks | Whether a model prioritizes trusted instructions over untrusted ones | Tests a *generic* system prompt, not yours. A model can pass IHEval and still fail against your harness's actual system prompt structure and length. |
| All of the above | Typically evaluated against full-precision or lightly-quantized frontier models | Local models via Ollama/LM Studio/Lemonade are frequently quantized (4-bit, 5-bit GGUF, etc.), which measurably degrades tool-calling accuracy and instruction-following — a variable these benchmarks don't isolate. |

There's also a structural caveat worth stating plainly: independent reviews of these benchmarks (including a UC Berkeley review of GAIA, SWE-bench, WebArena, OSWorld, and Terminal-Bench) have identified real methodological problems with several of them, and practitioners deploying agents in production consistently report that no single published benchmark predicted their actual production failures. That finding applies with even more force to a bring-your-own-LLM platform, where the model pool spans a much wider range of capability, format compliance, and quantization level than the frontier models these benchmarks were built around.

**Conclusion:** these benchmarks are useful as a *general capability prior* — a way to sanity-check that a model is roughly in the right tier — but they should not be presented to users as a harness-compatibility score. Doing so would give a false sense of confidence about behavior that is specific to your harness's protocol, not the model's general intelligence.

---

## The Berkeley Function Calling Leaderboard (BFCL): A Strong Template

One existing benchmark stands out as substantially closer to the problem at hand: the **Berkeley Function Calling Leaderboard (BFCL)**.

### What BFCL actually tests

BFCL is purpose-built to evaluate function calling / tool use — an LLM's ability to invoke external functions, APIs, or user-defined tools correctly in response to a query. Its design has several properties that map directly onto the harness-compatibility problem:

- **Abstract Syntax Tree (AST) evaluation** — it checks tool-call correctness structurally rather than via string matching, and scales to thousands of candidate functions.
- **Serial and parallel function-call evaluation** — it doesn't just test single tool calls, it tests chained and simultaneous calls, which is closer to real agentic behavior.
- **A native "FC" vs. "Prompt" split** — BFCL explicitly separates models with native function-calling support from models that require a prompted JSON-schema workaround. This is exactly the split you'll encounter across Ollama, LM Studio, and Lemonade models, where some expose a proper tool-calling API and many don't.
- **Multi-turn, stateful evaluation** — later versions test whether a model can maintain state and reason correctly across multiple tool-calling turns, plus whether it can appropriately *abstain* from calling a tool when it shouldn't.
- **Latency and cost reporting** — each model's results are reported alongside estimated latency and cost, which is directly relevant to local models where inference speed on the user's own hardware is a first-class concern.

### Why it's a good template rather than a drop-in solution

BFCL is still a *general* function-calling benchmark — it uses its own curated function library and prompts, not your harness's actual tools, system prompt, or payload shapes. But its **methodology** is exactly the right shape to adapt:

- Structural (AST-style) correctness checking instead of fragile string matching
- Explicit handling of the native-vs-prompted tool-calling divide
- Multi-turn, stateful task design
- Built-in latency/cost accounting

---

## Recommended Approach: A Harness-Specific Smoke Test, Built on the BFCL Methodology

Rather than running BFCL wholesale (which tests general function-calling ability against generic functions) or relying on general agent benchmarks (which don't test compatibility at all), the recommendation is to **build a lightweight, in-platform "harness smoke test"** that borrows BFCL's evaluation methodology but runs it against your platform's actual tools, prompts, and payload shapes.

### Proposed structure

1. **Format compliance test**
   Using BFCL's AST-style structural checking, verify the candidate model reliably emits tool calls in the harness's exact expected format (schema, XML, etc.), for both FC-native and prompted models. This single test eliminates the largest class of "works with a frontier model, breaks locally" failures.

2. **Multi-step tool chaining test**
   Adapt BFCL's multi-turn, stateful evaluation design: call tool A, feed back a realistic result, and confirm the model correctly incorporates it into a coherent next step rather than repeating itself or hallucinating a result.

3. **Instruction-hierarchy / injection resistance test, run against your real system prompt**
   Reuse the intent of IHEval-style testing, but test it against the harness's actual production system prompt and length — not a generic one — since compatibility here is prompt-specific, not general-model-specific.

4. **Context-length degradation test**
   Feed tool-output payloads sized like the harness's real (often verbose) responses, and confirm the model still tracks the original goal. This matters especially for local models, which are frequently run with reduced effective context windows relative to their advertised maximum.

5. **Error-recovery test**
   Deliberately return a malformed or error tool result and observe whether the model retries sensibly or spirals. This predicts real production failures far more reliably than any clean-path benchmark.

6. **A small set of golden-path tasks using the platform's actual skills**
   5–10 end-to-end tasks built from the harness's real available tools, scored pass/fail. This is the highest-signal component of the whole smoke test, because it evaluates the exact thing users will do — not a proxy for it.

### Presenting results to users

Rather than collapsing this into a single leaderboard-style score (which would hide the specific failure mode a user needs to know about), present a compatibility report broken out by dimension, for example:

- ✅ Tool-call format compliance
- ✅ Multi-step tool chaining
- ⚠️ Degrades past ~8K tokens of tool output
- ❌ Fails to recover from malformed tool results

This gives users an actionable, harness-specific answer to "will this model work well here?" — grounded in BFCL's proven evaluation methodology, but scoped to the tools, prompts, and constraints of the actual platform rather than a generic benchmark's function library.

---

## Summary

- General agent benchmarks (GAIA, SWE-bench, OSWorld, WebArena, tau-bench, METR) measure general capability, not harness compatibility, and shouldn't be presented to users as a compatibility signal.
- Instruction-hierarchy and prompt-injection benchmarks are valuable concepts but need to be re-run against the harness's *actual* system prompt to be meaningful.
- BFCL is the closest existing benchmark to the problem, and its methodology — AST-based structural correctness, native-vs-prompted handling, multi-turn state, latency/cost accounting — is the right template to adapt.
- The recommended solution is a purpose-built, in-platform smoke test that applies BFCL's evaluation approach to the harness's own tools, prompts, and payload shapes, reported as a dimension-by-dimension compatibility profile rather than a single score.
