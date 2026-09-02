# Research: Caching Embeddings for Non-Text Files (Images etc.)

Research for [issue #125](https://github.com/tkottke90/amazing-hashbrown/issues/125). **This is the weakest-answered of the three questions — the honest verdict is that the specific thing being asked about (an embedding cache) is not an established, documented, at-scale practice, and none of the evidence gathered confirms it as one.** Read the whole doc, not just this line, before deciding whether to build one anyway.

## 1. Overview of the Question

The premise in the issue: if a user attaches the same image to a conversation and the harness re-runs (retries, multi-turn follow-ups, etc.), does the system need to re-compute/re-embed that file every single time, or is there a standard caching layer that avoids that repeated cost?

Two different things are easy to conflate here, and the research surfaced a real distinction:
- **Avoiding re-sending/re-encoding raw bytes** (a payload/bandwidth optimization).
- **Avoiding re-computing a model's internal embedding/encoder representation of the file** (a compute optimization, done inside an inference engine, not in a client harness).

## 2. Information Found

**Two verified, weaker recommendations — no verified evidence of an established embedding-cache pattern.**

### What's actually supported by evidence:

1. **Context-management, not embedding caching.** LangChain's `deepagents` docs recommend that for long agent runs, non-text content (screenshots, charts, images) should be stored in a filesystem backend or external object store, with only a file path or URL passed through the conversation messages — not the raw bytes re-embedded into context on every turn. This is framed explicitly as **context-size / token-bloat management**, not as avoiding re-computation cost. An independent LangChain community forum thread gives the same advice. This solves "don't blow up your context window with repeated base64 blobs," which is a real and relevant problem for this repo's chat harness — but it is not embedding caching.

2. **Upload-once-reference-many via provider Files APIs.** Both Anthropic and Gemini offer a Files API: upload a file once, get back a reference (`file_id` for Anthropic), and pass that reference in subsequent requests instead of re-sending/re-encoding the raw file each time. This avoids repeated base64 encoding and repeated payload transfer. **This is the closest thing to a real, vendor-documented answer to the spirit of the question** — but it's the provider avoiding re-*ingesting* your upload, not the harness avoiding re-*embedding* a vector representation itself. One narrower claim — that Anthropic explicitly frames this as being *for* avoiding re-processing cost across turns — did not survive verification (voted down 1-2); the Files API exists and works this way, but don't over-attribute the vendor's stated rationale.

### What was checked and refuted (i.e., don't repeat these as fact):

- A claim that vLLM's default behavior wastefully re-encodes identical media on every request (used as the motivating case for building a cache) was **refuted (1-2)**.
- The specific mechanism — a deterministic content hash (`mm_hash`, e.g. SHA-256 of raw bytes) used as a cache key for a computed embedding — comes from a **vLLM RFC/design discussion, not confirmed shipped behavior**, and the claim that this is "the recommended caching mechanism" was **refuted (1-2)**.
- vLLM issue **[#21113](https://github.com/vllm-project/vllm/issues/21113)** — "[RFC]: Reuse multimodal embeddings from encoder cache" — is real, but it is a **proposal under discussion in an inference-serving engine**, not a settled, at-scale pattern you'd be adopting by reference. It's also solving a different layer of the stack: vLLM is the model-serving engine itself caching encoder output across inference requests it serves. That's not the same layer as this repo's chat harness, which talks to hosted provider APIs (Anthropic/Gemini) rather than running its own inference engine.

## 3. How This Would Be Implemented "At Scale" — Honest Assessment

There isn't a proven "at scale" implementation to point to for the actual question asked (harness-level embedding cache for repeated non-text input). What *is* proven at scale:

- **Files API reuse** (Anthropic, Gemini) is production, vendor-supported, and directly reduces repeated encode/transfer cost for a file reused across multiple turns or requests. If `amazing-hashbrown`'s harness re-sends the same attachment across turns in a thread, uploading once via the provider's Files API and storing the returned reference (alongside the attachment metadata) is the correct, supported pattern — not a custom embedding cache.
- **External storage + reference passing** (deepagents' pattern) is the right fix for context-window bloat from repeated large attachments, independent of the Files API question.
- A genuine **embedding-level cache** (hash the file, cache the provider's internal vector representation, skip re-embedding on retry) is **not something the provider APIs expose to a client at all** — Anthropic/Gemini don't return or accept a pre-computed embedding for a vision input; the embedding happens inside their model and isn't a client-cacheable artifact via the public chat/messages APIs. That pattern only exists in the vLLM RFC, which is about a self-hosted inference engine, not a hosted API client.

**Recommendation:** Don't build a custom embedding cache for this feature. Build the two proven pieces instead — Files-API reuse for repeated-attachment turns, and external storage/reference-passing to keep conversation context lean — and treat "should we cache embeddings" as a non-issue for a harness that calls hosted provider APIs rather than running its own model-serving stack.

## 4. References

- LangChain deepagents multimodal docs (context-management recommendation): https://docs.langchain.com/oss/python/deepagents/multimodal
- Anthropic Files API docs (upload once, reference by `file_id`): https://platform.claude.com/docs/en/build-with-claude/files
- Google Gemini image understanding docs (Files API vs. inline base64): https://ai.google.dev/gemini-api/docs/image-understanding
- vLLM RFC — encoder cache for multimodal embeddings (design discussion, not shipped/settled): https://github.com/vllm-project/vllm/issues/21113

## Open Questions Carried Forward

- No authoritative source was found for a harness-level (not inference-engine-level) pattern of caching computed embeddings for repeated non-text input, keyed by content hash. If this becomes a real cost problem, it's a genuinely open design question, not something to solve by copying an existing pattern.
- What is the actual retry/re-send frequency of the same attachment in this repo's expected chat workload? That determines whether Files-API reuse alone is sufficient or whether it's worth investing in anything more elaborate. Worth measuring before building.
