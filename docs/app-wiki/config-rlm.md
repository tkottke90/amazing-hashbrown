## Retrieval Loop Model (RLM) Configuration

The Retrieval Loop Model (RLM) is a specialized reasoning loop used by the `rlm_query` tool. It handles situations where the relevant information spans a large body of text — more than a single wiki page read can efficiently return.

### Configuration Section

All RLM settings live under the `rlm` key in `config.yaml`:

```yaml
rlm:
  maxIterations: 10
  truncateThreshold: 6000
  provider: local
  model: llama3.1
```

### Settings Reference

**`maxIterations`** (default: `10`)

The maximum number of retrieval loop cycles before the RLM gives up and returns whatever it has found so far. Increasing this allows deeper exploration of large corpora but uses more tokens and time.

**`truncateThreshold`** (default: `6000`)

When the `wiki_read_page` tool reads a page longer than this character count, it truncates the output and suggests using `rlm_query` instead. Lowering this value causes the RLM to be invoked more frequently; raising it means longer pages are read in full by the main agent before falling back to RLM.

**`provider`** (optional)

The name of the provider to use for RLM inference. Defaults to `defaultProvider` if not set. Set this to use a different provider than your main chat provider.

**`model`** (optional)

The model to use for RLM inference. Defaults to the provider's `defaultModel` if not set.

### Cost Optimization Pattern

A common configuration is to use a fast, cheap model for RLM — since retrieval loops run many small inference steps — and reserve a smarter, more capable model for the main chat agent:

```yaml
defaultProvider: anthropic  # used for main chat

rlm:
  provider: local            # Ollama for RLM
  model: qwen2.5:7b          # fast local model
  maxIterations: 10
```

This can significantly reduce cloud inference costs while keeping response quality high for the parts of the conversation that matter most to the user.

See [[Retrieval Loop Model]] for a detailed explanation of how the RLM works. See [[How to Add a Provider]] and [[How to Set Up Ollama]] for provider setup.
