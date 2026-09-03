# Research: Detecting Multi-Modal Model Support via the LangChain Interface

Research for [issue #125](https://github.com/tkottke90/amazing-hashbrown/issues/125). Findings verified by a 3-vote adversarial pass over 15+ extracted claims across 6 primary/forum sources.

## 1. Overview of the Question

Before the chat harness can send an image (or other non-text attachment) to a model, it needs to know whether the currently-selected model/provider combination actually accepts that kind of input. Sending an image blob to a text-only model either errors or is silently ignored depending on provider — neither is acceptable UX. The question: does LangChain give us a way to check this programmatically, or do we have to hardcode per-provider/per-model capability tables ourselves?

## 2. Information Found

**Yes — LangChain has a capability-detection mechanism, but it's beta and not universally documented.**

- Every chat model built on `BaseChatModel` (langchain_core) exposes a `.profile` property. This returns a `ModelProfile` — a `TypedDict` — describing what the model can do.
- Relevant boolean fields on `ModelProfile`: `image_inputs`, `image_url_inputs`, `pdf_inputs`, `audio_inputs`, `video_inputs`, `text_inputs`. There are also non-boolean/functional fields such as `max_input_tokens` and tool-calling support.
- This requires **LangChain ≥ 1.1**. It is explicitly labeled **beta** — the shape can still change — and the underlying data is partly sourced from the third-party [models.dev](https://models.dev) project rather than being hand-verified per provider by LangChain itself.
- Documentation coverage of `.profile` is inconsistent across LangChain's own docs surfaces:
  - `docs.langchain.com/oss/python/langchain/models` documents it directly with the field list above.
  - The generated API reference page for `BaseChatModel` lists `profile` as a property but with **no description of what it returns** — you'd need to already know to look elsewhere.
  - LangChain's own `deepagents` docs (`docs.langchain.com/oss/python/deepagents/multimodal`) don't mention a programmatic check at all — they tell developers to go read the provider's own docs for supported MIME types. So even within LangChain's ecosystem, `.profile` isn't treated as the single source of truth yet.
- One claim that was checked and **refuted**: there is no `ModelProfileRegistry` object for looking up profiles by model name independent of an instantiated model — you get the profile from an actual model instance (`model.profile`), not from a static registry.

## 3. How This Is Implemented Successfully (Real Usage)

The clearest real-world evidence of `.profile` being used exactly for this purpose comes from LangChain's own `deepagents` project:

- **[langchain-ai/deepagents#1313](https://github.com/langchain-ai/deepagents/issues/1313)** — "Enable image reads from files based on model profile." The maintainers' proposed fix is to gate file-based image reads on `model.profile.image_inputs`, so the agent only attempts to hand an image to the model when the active model's profile says it accepts image input. This is the same shape of decision this repo needs to make before wiring an attachment into a message.

Practical pattern this implies for `amazing-hashbrown`:

```python
if attachment.kind == "image" and not model.profile.get("image_inputs"):
    # reject / warn in UI, don't send the attachment
```

Given the beta status, treat `.profile` as a **hint with a fallback**, not gospel:

1. Check `model.profile[<kind>_inputs]` first — cheap, no network call, and it's the same mechanism LangChain's own agents are moving to.
2. If `.profile` is missing/empty for a model (older LangChain version, or a provider not yet in the models.dev dataset), fall back to a small provider-specific capability table we maintain ourselves (see the preprocessing research doc for the concrete per-provider constraints that table would need anyway).

## 4. References

- LangChain `ModelProfile` source: https://github.com/langchain-ai/langchain/blob/57c83d44bc8ae89a189ad521b9756cfac996039c/libs/core/langchain_core/language_models/model_profile.py
- LangChain models docs (documents `.profile` and its fields): https://docs.langchain.com/oss/python/langchain/models
- `BaseChatModel` reference (lists `profile` property, no description): https://reference.langchain.com/python/langchain-core/language_models/chat_models/BaseChatModel
- `langchain-core.language_models` reference (confirms no `ModelProfileRegistry`): https://reference.langchain.com/python/langchain-core/language_models
- Real-world usage discussion — deepagents issue: https://github.com/langchain-ai/deepagents/issues/1313
- deepagents multimodal docs (shows the doc-coverage gap — no programmatic method mentioned): https://docs.langchain.com/oss/python/deepagents/multimodal

## Caveat

`.profile` is an explicitly-labeled beta feature gated behind `langchain>=1.1`, with data partly sourced from a third-party project (models.dev). Verify the installed LangChain version in this repo supports it, and re-check the exact field names against the installed version before relying on it in code — the format is subject to change.
