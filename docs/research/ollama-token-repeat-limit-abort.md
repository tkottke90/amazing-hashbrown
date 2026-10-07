# What is Ollama's "prediction aborted, token repeat limit reached" error and what do we do about it?

**Scope:** The server-side Ollama error `prediction aborted, token repeat limit reached`, as seen by
our eval harness running `gpt-oss:20b` on Ollama (Apple M1) through `@langchain/ollama` 1.3.0 and
the `ollama` JS client. Source code, official Ollama docs and release notes, and OpenAI's `gpt-oss`
repository are treated as primary. Third-party issues and guides are cited only as secondary and
labelled as such. Nothing here was run against a live Ollama server; this session had no access to
one.

**What was read, and at which version:**

| Source                                     | Pinned at                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `ollama/ollama` (current stable tag)       | `v0.40.0` = `0d0720e51fb2fd9aa58781c3d720c06d720c2e7b` (tagged 2026-10-06) |
| `ollama/ollama` `main` at time of reading  | `d3c846f8b0279e79b0e3a960a7575fde6920e9df` (2 commits after `v0.40.0`)     |
| `ollama/ollama` (before the error existed) | `v0.34.0`, `v0.20.0` (`de9673ac…`), `v0.12.0` (`9f3a37fd…`)                |
| `openai/gpt-oss` `main`                    | `7b583341fe16729127f6d5b94a7b09ccae97e1a1` (2026-07-24, shallow clone)     |

`main` and `v0.40.0` differ by 9 files (cloud proxy, cloud usage docs, `openapi.yaml`, a llama.cpp
compat file and tests). Of the files cited below only `server/routes.go` differs (18 added lines,
so some of its line numbers shift on `main`). Line numbers below are for `v0.40.0` unless stated.
All commit, tag and line data came from a local clone of `github.com/ollama/ollama` (full history,
`git log -S`, `git show <tag>:<path>`), so tag and version attributions are `git tag --contains`
results, not release-page claims, unless a release page is cited.

---

## Summary: direct answers

| #   | Question                                         | Short answer                                                                                                                                                                                                                                                                                                                        | Support                                                                                                                             |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where does the string come from?                 | Ollama's Go server code, in the process that talks to the inference runner (`llm/llama_server.go`, `llamaServerRunner.Completion`, since v0.30.0; earlier `llm/server.go`, `llmServer.Completion`). Added 2024-03 (PR #3080, v0.1.29) with a limit of 30 and a silent stop; became a returned error with a limit of 100 in v0.34.1. | **Confirmed (primary source)**                                                                                                      |
| 2   | What does it detect? Is it configurable?         | The same streamed chunk (whitespace-trimmed) repeated back-to-back: more than 100 repeats after the first, so the 102nd identical chunk in a row. Hard-coded literal. No env var, request option or Modelfile parameter.                                                                                                            | **Confirmed (primary source)**; "not configurable" is confirmed by absence in code and docs                                         |
| 3   | How does it surface?                             | `/api/chat` and `/api/generate`: non-streaming gives HTTP 500 `{"error": ...}` and discards partial text; streaming gives HTTP 500 if nothing was written yet, otherwise an `{"error": ...}` NDJSON line after HTTP 200. OpenAI-compatible streaming mid-error: likely a silently truncated stream.                                 | **Confirmed (primary source)** for the native API; **Inference** for the OpenAI-compatible mid-stream case                          |
| 4   | Known causes and reports                         | No maintainer analysis found. Public reports are mostly OCR models and a prompt-cache regression. No Ollama issue found that pairs this exact message with `gpt-oss`, temperature 0, tool calls or Apple Silicon. Separate `gpt-oss` repetition-loop reports exist without this message.                                            | **Secondary report** (issues are first-party GitHub issues, but the claims in them are user-reported)                               |
| 5   | Mitigations; `gpt-oss` guidance on sampling      | OpenAI recommends `temperature=1.0`, `top_p=1.0` for `gpt-oss`; Ollama's own `gpt-oss` Modelfile sets only `temperature: 1`. OpenAI does not say greedy decoding is forbidden. A llama.cpp guide says not to use repetition penalties.                                                                                              | **Confirmed (primary source)** for the recommendation; **Secondary report** for "no repetition penalty" and for temperature-0 loops |
| 6   | Can default `num_ctx` and truncation contribute? | Default `num_ctx` is chosen from GPU memory (4k below 24 GiB, 32k, 256k above 48 GiB) since v0.15.5; before that `gpt-oss` got 8192 unless low-VRAM. Prompt truncation logs at debug level (message-level) or warn level (token-level). A causal link to repetition loops is not shown by any source.                               | **Confirmed (primary source)** for defaults and log levels; **Inference** for any link to loops                                     |

---

## 1. Where the message originates

### 1a. Current code (v0.40.0)

The message is in one place, `llm/llama_server.go`, in `(*llamaServerRunner).Completion`
(function starts L1623). It is the Go server's client for the `llama-server` subprocess it
launches. The loop reads the runner's server-sent-events stream and keeps a counter:

```go
// llm/llama_server.go:1770-1771, 1798-1808 (v0.40.0)
var lastToken string
var tokenRepeat int
...
// Token repeat detection
switch {
case strings.TrimSpace(lsResp.Content) == lastToken:
	tokenRepeat++
default:
	lastToken = strings.TrimSpace(lsResp.Content)
	tokenRepeat = 0
}
if tokenRepeat > 100 {
	slog.Debug("prediction aborted, token repeat limit reached")
	return fmt.Errorf("prediction aborted, token repeat limit reached")
}
```

Permalink:
<https://github.com/ollama/ollama/blob/0d0720e51fb2fd9aa58781c3d720c06d720c2e7b/llm/llama_server.go#L1770-L1808>

Two details worth noting, both from reading the code:

- The `slog.Debug` line only appears in the server log when `OLLAMA_DEBUG` is set
  (`envconfig.LogLevel()` defaults to Info; `envconfig/config.go`). The returned error text, not the
  log line, is what clients see.
- `main` has the same block at `llm/llama_server.go:1806-1808`
  (`d3c846f8b0279e79b0e3a960a7575fde6920e9df`). `grep -rn "token repeat limit"` over the whole tree
  at `main` finds only these two lines. The MLX runner (`mlxrunner/`) has no equivalent.

### 1b. History: when and how it was introduced and changed

| Date       | Commit / PR                                                         | First stable tag containing it (`git tag --contains`) | Change                                                                                                                               |
| ---------- | ------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2024-03-12 | `3e22611200e9fdc44d24976cce7b36197448c972`, PR #3080 (BruceMacD)    | `v0.1.29`                                             | Introduced in `llm/dyn_ext_server.go`. Limit 30 ("arbitrary max token repeat limit"). Stops generation, no error. Fixes issue #1910. |
| 2024-03-14 | `58d95cc9bd446a8209e7388a96c70367cbafd653`                          | `v0.1.32`                                             | Moved with the "switch back to subprocessing for llama.cpp" change into `llm/server.go`.                                             |
| 2026-05-29 | `9db4bdbad6a4981ad761aa2b603e69e8fb83212c`, PR #16031               | `v0.30.0`                                             | CGO engines removed; check now lives in `llm/llama_server.go`.                                                                       |
| 2026-09-11 | `4512d2b76dd90c1387e4219eccee160ed47a1192`, PR #18374 (rick-github) | `v0.34.1`                                             | Limit raised 30 to 100, and `return ctx.Err()` replaced by `return fmt.Errorf("prediction aborted, token repeat limit reached")`.    |

Sources:

- Commit `3e226112` diff and message: <https://github.com/ollama/ollama/commit/3e22611200e9fdc44d24976cce7b36197448c972>
- PR #3080: <https://github.com/ollama/ollama/pull/3080>
- Commit `4512d2b7` diff (shows both changes in one hunk):
  <https://github.com/ollama/ollama/commit/4512d2b76dd90c1387e4219eccee160ed47a1192>
- PR #18374 (title: "llm: raise token repeat limit to 100 and return error instead of incomplete
  result"; merged per the PR page 2026-09-10; the commit's author date is 2026-09-11):
  <https://github.com/ollama/ollama/pull/18374>
- v0.34.1 release note: "Runaway repeat token detection now requires 100 repeat tokens for reduced
  false positives (e.g. OCR)" <https://github.com/ollama/ollama/releases/tag/v0.34.1>. The release
  note does not mention that the outcome changed from a clean stop to an error; the diff and the
  PR title do.

Before v0.34.1 the abort did `return ctx.Err()`. When the request context is not cancelled that is
`nil`, so `Completion` returned success without ever calling the callback with a `done` response.
Example from `v0.12.0`, `llm/server.go:1509-1512`:
<https://github.com/ollama/ollama/blob/9f3a37fd36bf1c46cc86a47bc5372535f8ee3547/llm/server.go#L1509-L1512>
and `v0.34.0`, `llm/llama_server.go:1703-1706`. PR #18374's description says the old behaviour
ended a 400-repeat test at 31 repetitions with `"done": false`, and the new behaviour returns the
error with HTTP 500 (as summarised from the PR page; the PR body was read through a page-summary
tool, not as raw text). Issue #18609 (secondary report) independently describes the same change
("stream ends cleanly, partial text is returned" on 0.34.0 versus HTTP 500 on 0.34.1+).

**Practical consequence:** on Ollama older than v0.34.1 the same degenerate loop would have ended
generation after 31 identical chunks with no error and a truncated reply. If our harness only started
seeing this message after an Ollama upgrade, the underlying behaviour may be older than the error.
This is an inference; no source says our runs were affected earlier.

### 1c. More than one runner or engine?

- From v0.30.0 onward there is one place. PR #16031 removed the vendored llama.cpp CGO runner
  and the Go-native "Ollama engine" model implementations and made `llama-server` (built from
  upstream llama.cpp) "the sole inference engine for GGUF-based models"; safetensors models use the
  MLX engine (commit message of `9db4bdba`). The check applies only to the `llama-server` path.
- Before v0.30.0 (tested at `v0.12.0`, `v0.13.0`, `v0.20.0`) the check was in
  `llm/server.go`, `(*llmServer).Completion` (L1537 at `v0.20.0`; check at L1659-1664), which is
  the parent-process client that POSTs to the runner's `/completion` endpoint. Both
  `runner/llamarunner/` (llama.cpp CGO) and `runner/ollamarunner/` (Ollama-native engine) were
  reached through that one function. `git grep` for `tokenRepeat` / `token repeat limit` in
  `runner/` at `v0.20.0` finds nothing, so neither runner contained its own copy. In other words:
  one copy of the check, shared by both engines, not one per engine.
- Which of those two engines served `gpt-oss:20b` on a given version before v0.30.0 was not
  verified here.

---

## 2. What it detects, and whether it is configurable

**Detection rule (confirmed from the code in 1a):**

- The unit is one streamed event from the runner, not a verified single token. Each event's
  `Content` is compared after `strings.TrimSpace`. Whether `llama-server` emits exactly one token per
  event was not verified from `llama-server` source in this session.
- It is "the same chunk as the previous chunk", period 1 only. An alternating pattern such as
  `A B A B` resets the counter every time and never trips it. There is no window and no
  n-gram search.
- `lastToken` starts as the empty string, and `TrimSpace` maps whitespace-only chunks to the empty
  string. So a run of consecutive chunks that are empty or only whitespace (for example a long run
  of newlines or indentation) counts as repeats from the very first chunk, and it takes 101 of them
  to abort. For a non-empty chunk the first occurrence sets `lastToken`, so the abort happens on
  the 102nd identical chunk in a row.
- It is applied to the raw runner output, before the chat handler's parsers split it into
  thinking, content and tool calls (the parser runs inside the callback passed to
  `r.Completion` in `server/routes.go`). So reasoning text from `gpt-oss` counts the same as
  answer text.

**Configurability: not configurable (confirmed by absence).**

- `100` is a literal in `llm/llama_server.go:1806`. At `main` the whole tree contains no other
  occurrence of the phrase. `envconfig/config.go` defines no variable for it. The `Options` struct
  and `DefaultOptions()` (`api/types.go:1176`) have no such field.
- Ollama's docs mention none of it: `grep -i "token repeat\|repeat limit"` over `docs/` and
  `README.md` at `main` finds nothing, and the Modelfile parameter table
  (`docs/modelfile.mdx`) lists only `repeat_last_n` and `repeat_penalty`, which are sampler
  settings and do not change this check.
- PR #3080's review discussion raised making the limit user-configurable; per the PR page summary
  the author chose to keep it separate. Nothing later changed that.

---

## 3. How it surfaces to API clients

All of this is from `server/routes.go`, `middleware/openai.go` and `docs/api/errors.mdx` at
`v0.40.0`.

- The error is returned from `Completion`; the handler's completion goroutine turns any non-status
  error into `ch <- gin.H{"error": err.Error()}` with no `status` key (`server/routes.go:3345-3347`
  for `/api/chat`, `806-843` for `/api/generate`). A `gin.H` error with no status is treated as
  HTTP 500.
- **Streaming (the default) on `/api/chat` and `/api/generate`:** `streamResponse`
  (`server/routes.go:2520`) writes the error as a plain JSON error with a 500 status if nothing has
  been written yet (`!c.Writer.Written()`, L2539). Otherwise it writes `{"error": "..."}` as an
  extra NDJSON line, and the status stays 200 because the response has already started. This matches
  the official docs: "If an error occurs mid-stream, the error will be returned as an object ... with
  an `error` property. Since the response has already started, the status code of the response will
  not be changed." (`docs/api/errors.mdx:26-38`). Partial output already sent is kept by the client;
  there is no final `done: true` message.
- **Non-streaming (`"stream": false`):** `writeChatResponse` (`server/routes.go:2841`) and the
  generate equivalent collect chunks, but on a `gin.H` error they return `c.JSON(status,
{"error": msg})` and `return`. Partial text is discarded and the client gets HTTP 500.
- **Whether a streaming client sees a 500 or a mid-stream error line** depends on whether any
  chunk had reached the client before the abort. The built-in parser path in the chat handler only
  forwards a chunk when it has content, thinking or tool calls to send, so a model that is
  generating tool-call arguments through the parser may not have flushed anything. Which of the two
  our harness sees was not checked.
- **OpenAI-compatible `/v1/chat/completions`:** `ChatWriter.Write` (`middleware/openai.go:178`)
  routes to `writeError` only when the response status is not 200, which converts the error into an
  OpenAI-shaped error with `type: "api_error"`. That is the non-streaming case and the
  nothing-written-yet streaming case. For a mid-stream error the status is already 200, so the
  `{"error": ...}` line is handed to `writeResponse`, which unmarshals it into `api.ChatResponse`
  (a struct with no `error` field). **Inference from the code, not run:** the error text is dropped,
  the client sees at most an empty chunk, and the stream ends without a finish chunk or
  `data: [DONE]`. This does not affect our harness, which uses `/api/chat`, but matters if the
  Lemonade/OpenAI path is ever pointed at Ollama.
- `@langchain/ollama` and the `ollama` JS client are out of scope here; the task brief already
  verified that the client throws `message.error` when a streamed message carries one.

---

## 4. Known causes and reports

No maintainer explanation of root causes was found in any of the sources below. Everything
here is user-reported unless stated.

**First-party GitHub issues and PRs (the reports in them are secondary):**

| Item                                                                       | Version / model                               | What it says                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1910](https://github.com/ollama/ollama/issues/1910) (closed by PR #3080) | 0.1.17-0.1.19, `format: json`                 | Original motivation: JSON-format requests hang on repeated tokens. Closest primary-source match to "structured output".                                                                                                                                        |
| [#8786](https://github.com/ollama/ollama/issues/8786)                      | 0.5.7, granite3.1-dense:8b q6_K, `/api/chat`  | Log shows the message; reply was a stream of repeated `<fim_prefix>` tokens. Reporter says context was not exceeded (18k prompt in a 32k window). No maintainer analysis.                                                                                      |
| [#17270](https://github.com/ollama/ollama/issues/17270)                    | 0.20.7 worked, 0.32.1 failed, `/api/generate` | Abort on a 1,653-token prompt in an 8,192 context. Reporter ties it to prompt-cache reuse after "cache size limit reached". Closed as not planned.                                                                                                             |
| [#18609](https://github.com/ollama/ollama/issues/18609)                    | 0.34.1/0.34.2, glm-ocr                        | HTTP 500 on requests that returned partial text on 0.34.0. Reporter attributes it to the model never emitting its end-of-turn token plus PR #18374 turning a silent stop into an error. Open at time of reading.                                               |
| [#18810](https://github.com/ollama/ollama/issues/18810)                    | 0.35.1, glm-ocr                               | Loops ending in the message; reporter points at the bundled llama-server build changing between versions. Open.                                                                                                                                                |
| [#12741](https://github.com/ollama/ollama/issues/12741)                    | 0.12.6, Apple M1 Pro, `gpt-oss:20b`           | Repeated chunks in reasoning, worse with typos in the prompt, with `temperature: 0.001`, `repeat_penalty: 5.0`, `repeat_last_n: -1`. Does not mention the message. Closed as duplicate. This is the only `gpt-oss` + Apple Silicon + near-greedy report found. |

**Third-party report (secondary, not an Ollama or OpenAI source):**

- [ai-jury issue #857](https://github.com/berkayturanci/ai-jury/issues/857): `gpt-oss:20b` on Ollama
  0.34.1 (Apple M4 Pro) at a hard-coded `temperature: 0` hit `finish_reason=length` at 8,192 tokens
  with empty content; the reasoning was a loop ("Ok." 164 times, "Stop." 48 times). They report
  repetition penalty 1.05 still looped and 1.15 corrupted file paths. This describes greedy-decoding
  loops on `gpt-oss`, but the loops were repeated phrases rather than a documented
  single-chunk run, so it does not show the abort firing.
- [Folio-OCR issue #12](https://github.com/vorojar/Folio-OCR/issues/12): on 0.34.1/0.34.2 about half
  of OCR pages failed with the message; log lines show prompt-cache reuse (`lcp = 4080,
f_keep = 0.902`). They suspect stale cached state and work around it by pinning 0.34.0 or making
  prompts unique per request. Reporter's diagnosis, not confirmed by a maintainer.

**What was searched and not found:** no Ollama issue or PR whose text pairs this error with
`gpt-oss`, with temperature 0, with tool calling or structured JSON output generated by a
tool-use model, with long free-text tool arguments, or with Metal. This is a statement about
what search surfaced (web search over GitHub, plus the issue pages above), not proof none exist;
GitHub's own issue search was not reachable from this session.

**What the code does tell us, independent of reports:** `llama-server` receives
`cache_prompt: true` on every request (`llm/llama_server.go:1657`), so KV-cache reuse across
requests is always on. Cache reuse is the only mechanism two reports (#17270, Folio-OCR) blame for
loops that did not occur on a cold run.

---

## 5. Documented mitigations and `gpt-oss` sampling guidance

### 5a. What OpenAI and Ollama say about `gpt-oss` sampling (primary)

- OpenAI's `gpt-oss` repository, "Recommended Sampling Parameters": "We recommend sampling with
  `temperature=1.0` and `top_p=1.0`."
  <https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/README.md#recommended-sampling-parameters>
  (README lines 574-576). The same README's vLLM example also uses `temperature=1`.
- OpenAI's `gpt-oss` README, its harmony format guide (`openai-cookbook`
  `articles/openai-harmony.md`) and the cookbook article on running `gpt-oss` with Ollama were all
  searched for `temperature`, `top_p`, `greedy`, `sampling` and repetition guidance. Apart from the
  sentence above they contain no sampling advice, and **none says that temperature 0 or greedy
  decoding is discouraged or unsupported.** The recommendation is a positive one (use 1.0 / 1.0),
  not a prohibition. A model card PDF was not fetched.
- Ollama's library entry for `gpt-oss:20b` ships a parameters layer of `{ "temperature": 1 }`
  and nothing else (<https://ollama.com/library/gpt-oss:20b>, read 2026-10-07). So Ollama's
  defaults for `top_p` (0.9) and `top_k` (40) still apply unless set. Issue
  [#11725](https://github.com/ollama/ollama/issues/11725) (secondary) reports exactly this
  mismatch against OpenAI's `top_p=1.0`; it had no maintainer reply when read.
- Our harness sets `temperature: 0` explicitly, which overrides that Modelfile `temperature: 1`
  (`Server.modelOptions` in `server/routes.go:124` applies defaults, then the model's parameters,
  then the request's options; the commit message of `6a261db7` describes the same layering).
- Secondary source: the llama.cpp guide for running `gpt-oss`
  (<https://github.com/ggml-org/llama.cpp/discussions/15396>, by ggerganov) repeats OpenAI's
  `temperature=1.0 and top_p=1.0`, says "Do not use repetition penalties!", and warns that default
  `top_k 40` and `min_p 0.1` also apply. Only the first 100,000 of the page's 126,156 characters
  were read.

### 5b. Ollama's own sampler defaults (primary)

`DefaultOptions()` at `v0.40.0` (`api/types.go:1176-1203`):
<https://github.com/ollama/ollama/blob/0d0720e51fb2fd9aa58781c3d720c06d720c2e7b/api/types.go#L1176-L1203>

| Option           | Default  | Notes                                                          |
| ---------------- | -------- | -------------------------------------------------------------- |
| `num_predict`    | -1       | Unlimited generation; nothing but the context window bounds it |
| `temperature`    | 0.8      | Overridden to 1 by the `gpt-oss` library Modelfile             |
| `top_k`          | 40       |                                                                |
| `top_p`          | 0.9      |                                                                |
| `repeat_last_n`  | 64       | `0` disables, `-1` means `num_ctx` (`docs/modelfile.mdx:149`)  |
| `repeat_penalty` | 1.0      | Disabled. Was 1.1 before PR/commit `6a261db7` (see below)      |
| `seed`           | -1       | Random unless set; we set 42                                   |
| `num_ctx`        | per VRAM | See section 6                                                  |

The repeat-penalty default changed: commit `6a261db7` (2026-08-11, "api: stop applying
repeat_penalty 1.1 to models that don't set one") first shipped in `v0.32.10-rc0`; the v0.32.10
release note says: "Models that don't set a `repeat_penalty` now default to 1.0 (off) instead of
1.1 ... set a per-model parameter if an older model repeats itself."
<https://github.com/ollama/ollama/releases/tag/v0.32.10>. The commit message lists `gpt-oss` among
the models whose maker recommends no penalty. The Ollama-native engine had no repeat-penalty code
at `v0.20.0` (`git grep -i repeat` in `runner/ollamarunner` and `sample`; a token-history sampler
added in PR #14537 was reverted in `54e05172`), so on that engine `repeat_penalty` did nothing for
`gpt-oss` on older versions. That `gpt-oss` ran on that engine in those versions was not
verified.

### 5c. Mitigation checklist, with what each source supports

| Lever                                    | What a source says                                                                                                                                                                                                                      | Support                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `temperature` / `top_p` toward 1.0 / 1.0 | OpenAI's recommendation (5a). Secondary reports of greedy loops (ai-jury #857). No source says changing it prevents this specific abort.                                                                                                | Primary for recommendation; secondary for effect                      |
| `repeat_penalty` / `repeat_last_n`       | Ollama defaults to 1.0 (off) for `gpt-oss`; llama.cpp guide says not to use one for `gpt-oss`; reports (#12741, ai-jury #857) show high penalties did not stop loops and 1.15 corrupted output. No source recommends it for this error. | Secondary                                                             |
| `num_predict`                            | Documented option; bounds total output, so a runaway generation ends with `done_reason: length` instead of burning to the context limit. It does not stop the repeat check from firing earlier.                                         | Primary (docs / defaults) for existence; **Inference** for usefulness |
| `num_ctx` / `OLLAMA_CONTEXT_LENGTH`      | Documented (`docs/context-length.mdx`, `docs/faq.mdx`). See section 6.                                                                                                                                                                  | Primary                                                               |
| Flash attention                          | `OLLAMA_FLASH_ATTENTION=1/0` documented in `docs/faq.mdx:346`; Ollama enables it automatically when supported. No source links it to this error.                                                                                        | Primary for the setting; nothing on this error                        |
| Model / quantization change              | `gpt-oss:20b` ships MXFP4 (4.25 bits per parameter, 14 GB; ollama.com library page). No source ties the error to quantization.                                                                                                          | Nothing found                                                         |
| Runner / engine selection                | No setting. Since v0.30.0 there is one engine for GGUF models (section 1c).                                                                                                                                                             | Confirmed there is no choice                                          |
| Ollama version                           | The behaviour changed at v0.34.1 (section 1b); cache-related regressions are reported around 0.32.x-0.34.x (secondary).                                                                                                                 | Primary for the change; secondary for regressions                     |
| Raising or disabling the repeat limit    | Not possible without patching Ollama (section 2).                                                                                                                                                                                       | Confirmed                                                             |
| Prompt hygiene                           | #12741 reporter says fixing typos in the system and chat prompts reduced repetition (single anecdote).                                                                                                                                  | Secondary                                                             |

---

## 6. Default `num_ctx`, silent truncation, and logging

### 6a. What the default is, and how it depends on version and memory

- **Current rule (`v0.40.0`):** at server start Ollama sums the memory of detected GPUs (minus
  overhead) and picks a default `num_ctx`: under about 23 GiB gives 4,096; about 23 GiB up to
  47 GiB gives 32,768; 47 GiB and above gives 262,144 (`server/routes.go:2471-2481`; log line
  `vram-based default context` at Info level with `total_vram` and `default_num_ctx`). Permalink:
  <https://github.com/ollama/ollama/blob/0d0720e51fb2fd9aa58781c3d720c06d720c2e7b/server/routes.go#L2471-L2481>.
  Introduced by commit `0334ffa6250752c0e5e3d7f4467b0f50cc906fde` (2026-01-27), first tagged
  `v0.15.5-rc0`.
- The docs say the same: `docs/context-length.mdx` ("< 24 GiB VRAM: 4k context; 24-48 GiB: 32k;
  > = 48 GiB: 256k"; "Tasks which require large context like web search, agents, and coding
  > tools should be set to at least 64000 tokens"). `docs/faq.mdx` at the same tag still says "By
  > default, Ollama uses a context window size of 4096 tokens", so the two docs disagree; the code
  > and `context-length.mdx` agree with each other.
- **Before v0.15.5** (tested at `v0.12.0`): default 4,096, but with a special case that raised
  `gpt-oss` and `qwen3vl` to `max(NumCtx, 8192)` unless the machine was in "low VRAM mode" (total
  VRAM under 20 GiB). That special case is in the diff of `0334ffa6`, and `v0.12.0`'s `docs/faq.md`
  says "The `gpt-oss` model has a default context window size of 8192 tokens."
- **What this means for an M1:** Apple Silicon reports a single Metal device whose memory is a
  fraction of unified RAM (`discover/gpu_info_darwin.m` reads `recommendedMaxWorkingSetSize`; the
  newer path in `discover/llama_server.go` reads the device list from `llama-server`). A 16 GB
  M1 is far below the 23 GiB threshold, so it gets 4,096; only a high-memory M1 Max/Ultra could
  reach the 32k tier. Our machine's memory size and the value in its `vram-based default context`
  log line were not available. `OLLAMA_CONTEXT_LENGTH` and a request's `options.num_ctx` override
  the tier. Note that the OpenAI-compatible endpoint cannot set it per request
  (`docs/api/openai-compatibility.mdx:384-393` says to use a Modelfile).

### 6b. How oversized prompts are handled, and what is logged

Three separate mechanisms exist at `v0.40.0`:

1. **Message-level truncation** in `chatPrompt` (`server/prompt.go:23-77`): while the rendered
   prompt exceeds `num_ctx`, drop messages from the front, always keeping system messages and the
   last message. Logged only as `slog.Debug("truncating input messages which exceed context length")`
   (L77), i.e. invisible unless `OLLAMA_DEBUG` is set. Disabled by `"truncate": false` in the
   request (`api/types.go`: `Truncate`). The tool schemas are re-rendered into every prompt, so
   they are not something this step can drop.
2. **Token-level handling** in `completionPromptForRequest` (`llm/llama_server.go:282-322`): if the
   tokenized prompt reaches `num_ctx`, then with context shift disabled it returns HTTP 400 ("the
   prompt is longer than the context length currently available to the model ..."); with context
   shift enabled it keeps the first `num_keep` tokens, discards from the middle, and logs
   `slog.Warn("truncating input prompt", "limit", ..., "prompt", ..., "keep", ..., "new", ...)`
   (L320), a Warn level line that appears in the default log.
3. **Context shift during generation:** the scheduler launches `llama-server` with
   `--context-shift` (and `--keep N` if `num_keep > 0`) by default for every model except
   `deepseek2` (`server/sched.go:139-157`; `llm/llama_server.go:788-798`). The request defaults
   `num_keep` to 4 (`api/types.go`). What `llama-server` then does when generation fills the window
   is behaviour of llama.cpp, not Ollama source, and was not verified here. The `shift` request
   field (`api/types.go`: "when set to true, shifts the chat history when hitting the context length
   limit instead of erroring") controls it. PR #16712 (`bbb40a0a`, first tag `v0.30.9-rc1`) made
   shifting the default for all context sizes; before it, shifting was on by default only below an
   8,192 context.

So yes, silent truncation exists. Message-level dropping at Debug level is silent by default;
token-level truncation has a Warn log; generation-time shifting has no Ollama log line that was
found. For the prompt itself, the reply object reports `prompt_eval_count` (the token count after
truncation), which is a cheap way to detect that the prompt was cut (compare against the count
you expect); that field is documented in the API types (`api/types.go`, `Metrics.PromptEvalCount`).

**Secondary report on the same topic:** NousResearch/hermes-agent
[#43900](https://github.com/NousResearch/hermes-agent/issues/43900) describes agents silently
running at Ollama's 4,096 default because the OpenAI-compatible route ignored `options.num_ctx`.
That is a client bug report about context, not about repetition loops.

**Whether a short context contributes to repetition loops:** no source found says it does. The only
adjacent report is #17270 (a prompt well under `num_ctx` still aborted, tied by the reporter to
cache reuse, not truncation).

---

## What this means for our harness

_This section is interpretation. Nothing below is a sourced fact except where it points back to a
section above._

**Version first.** The error text is only an error from v0.34.1 on (1b). Before that, the same
degenerate run would have ended quietly after 31 identical chunks. Record `ollama --version` for
the failing machine; everything else depends on it. If it is below v0.34.1, this error should not
be possible, which would itself be a finding.

**Hypothesis 1: greedy decoding at temperature 0 causes loops.**

- _Supported (weakly)._ OpenAI's only stated guidance is `temperature=1.0`, `top_p=1.0` (5a); the
  Ollama library entry follows it for temperature; we override it with 0. A third-party report
  (ai-jury #857) shows `gpt-oss:20b` looping at temperature 0 on Ollama 0.34.1. The check fires on
  exactly the kind of failure greedy decoding is known for in general (the argmax token repeating),
  but only for a single repeating chunk (period 1), a narrower failure than a general loop.
- _Not shown._ No source reproduces the abort itself on `gpt-oss`, and the ai-jury loops were
  phrase-level, not single-chunk. Also OpenAI nowhere says greedy is forbidden.
- _Cheap test._ Same scenario, same seed, only `temperature` changed: 0, 0.2, 0.8 (Ollama's
  default), 1.0 with `top_p: 1.0` (OpenAI's recommendation). Run each at least 6 times (the
  failure rate is about 1 in 3, so 6 runs per arm gives about a 90% chance of seeing at least one
  failure per arm if the rate is unchanged). Compare failure counts, not single outcomes.

**Hypothesis 2: context truncation.**

- _Open._ If this machine is a typical 8 or 16 GB M1, the default is 4,096 (6a). Our prompt is a
  system prompt plus about 25 tool schemas plus a few messages, which plausibly approaches or
  exceeds 4,096 tokens, and the tool schemas cannot be dropped by message-level truncation (6b).
  Whether it actually overflows is a number we can measure. No source says truncation causes
  repetition, so this is only a candidate cause that is cheap to eliminate.
- _Cheap tests._ (a) Read `prompt_eval_count` from a failing run's final message and compare with
  the `vram-based default context` / `num_ctx` figure in the server log; if they are close,
  overflow is plausible. (b) Run the failing scenario with `options.num_ctx` set to 16384 or
  32768 (or `OLLAMA_CONTEXT_LENGTH`), with everything else unchanged. (c) Start the server with
  `OLLAMA_DEBUG=1` and look for `truncating input messages`, and (at default level) for
  `truncating input prompt`.

**Hypothesis 3: Ollama nondeterminism despite `seed: 42`.**

- _Plausible, not confirmed._ No source found says Ollama guarantees bit-identical output at
  temperature 0 with a seed. Ollama always sets `cache_prompt: true` (4), and two third-party
  reports tie loops to prompt-cache reuse across requests (#17270, Folio-OCR). Cache state differs
  between a cold and a warm run, which could vary results across runs of the same scenario.
  Neither report involved `gpt-oss`.
- _Cheap tests._ Run the scenario N times in a row (warm cache) versus with the model unloaded
  between runs (`keep_alive: 0`, or `ollama stop <model>`), and compare failure rates; or change
  only the first line of the system prompt per run to defeat prefix reuse. Also capture the raw
  stream with `curl` for a failing run and look at which chunk repeats and what text precedes it
  (whitespace? a closing quote? a repeated token inside the tool-call JSON?).

**Hypothesis 4: the free-text tool argument.**

- _Open._ Free text inside a JSON string is exactly where a model can emit long runs of the same
  token (spaces, newlines, repeated punctuation), and the check counts whitespace-only chunks
  (2). That is a reading of the code, not an observation. #1910 shows the check was created
  for JSON-format generation (1b), so the pattern is not new. No source ties it to `gpt-oss`.
- _Cheap test._ Look at the failing run's raw stream: if the repeated chunk is whitespace or a
  single punctuation token inside the argument string, the argument shape is implicated; if it is
  inside reasoning text before the call, it is not. A control: ask the same model for the same
  page content as plain text (no tool schema) at the same settings and see whether it loops.

**Not tied to our hypotheses but worth ruling out:** the version regression reports (#17270,
Folio-OCR, #18810) all involve changes between 0.20.x-0.35.x. If the failure rate is the same on a
second Ollama version (for example v0.34.0, which stops silently instead of erroring, or an
earlier stable), the issue is not a recent regression.

**Order of experiments that discriminates fastest:** (1) record the version and the log's
`default_num_ctx`; (2) capture one raw failing stream and read the repeated chunk; (3) re-run
with `num_ctx` raised; (4) re-run with `temperature: 1`, `top_p: 1`. Each is a one-setting change.
The harness cannot be modified from this research task, and none of these experiments has been
run.

---

## Observed: one abort, traced token by token (2026-10-07)

Everything above is from reading source. This section is the one measurement we have. It is a
single request, not a sample, and it is the first time the content of an abort has been seen.

**Setup:** Ollama `0.40.0` (the macOS app's bundled `llama-server`), Apple M1 Max, `gpt-oss:20b`,
`OLLAMA_DEBUG=2` (shown in the server config as `DEBUG-4`, i.e. trace). Scenario
`wnavh-003-read-page-indirect-phrasing` run with `npm run eval:trace` (one run), pinned
`temperature=0`, seed 42. The same scenario aborted 3 of 3 times earlier, with zero chunks reaching
the client each time (see `docs/App-Docs/Evaluations.md`, `eval:trace`).

**What the log shows:**

| Fact                          | Value                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt                        | 11,192 tokens (50,592 characters), the harness's full tool set (about 25 tools) bound                                                      |
| Context                       | `n_ctx_slot = 131072`, `truncated = 0` at the end of the run, so **not** a truncation problem                                              |
| Sampler (as logged)           | `temp = 0.000`, `top_k = 40`, `top_p = 0.900`, `repeat_penalty = 1.000`, no DRY, no frequency or presence penalty                          |
| Tokens generated before abort | 524                                                                                                                                        |
| Parser output                 | `builtin parser empty output` for **all 524**, and no `harmony event ...` line at all, so the parser never completed even a channel header |
| Time                          | about 35 s end to end, the abort comes from `llama_server.go:1807` and the API returns HTTP 500                                            |

**The raw token sequence** (one `content` per line in the trace, joined here):

```text
<|channel|> comment ? comment ary ? ? ?? ? ? ? ?? ? ?? ? ? ? ? ? ?? ? ?? ...   (about 50 tokens of ? and ??)
... ... … … … … ... ? … … …                                                    (tokens 50 to ~160)
comment ? … … … …                                                              (a second "comment ?" at token 162)
… … … … We … … … just … … … …                                                  (a few real words, then "…" again)
… × 101 consecutive (tokens 424 to 524)                                        → abort
```

Read plainly: the model begins an assistant message with `<|channel|>`, which is how `gpt-oss`
starts a tool call (`<|channel|>commentary to=functions.<name> ...`). It then fails to produce the
word `commentary` (it produces `comment`, `?`, `comment`, `ary`, `?`), never reaches a recipient or
arguments, and falls into emitting `?` and then `…` until the 102nd identical `…` trips the repeat
check. Because the harmony parser only emits once a header is complete, none of this was visible to
the client.

**What this does and does not establish:**

- It confirms the abort is a degenerate generation at the start of a tool call. The sampler is
  greedy with the repeat penalty off; this trace does not show whether either setting contributes.
- It ties the abort to the same family as the other `local` failures: the garbled
  `wiki_search?` tool name and the arguments returned as plain text are also a tool-call header
  going wrong, with `?` as a recurring bad token.
- It rules out context truncation and the default `num_ctx` for this request (sections 6a and 6b).
- It does **not** say why the model degenerates. One request cannot separate a prompt effect (an
  11k-token prompt with 25 tools), a quantisation or Metal numerics effect in this build, and
  greedy decoding at a point where the top choices are close.
- Because the request is deterministic at `temperature=0`, **retrying the identical request
  reproduces it** (3 of 3 earlier). A harness retry would only help if it changed something
  (sampling, seed at a non-zero temperature), which would then no longer be the pinned run.

Cheap experiments that would separate the explanations, none of them run:

1. The same scenario with `OLLAMA_FLASH_ATTENTION=1` (a numerics difference on Metal would show here).
2. The same scenario with a non-zero `--temperature`, to see whether the abort is specific to
   greedy decoding.
3. The same scenario on the old prompt (`f265cd6`), which did not abort on this scenario in its 3 earlier runs.

## Open questions / could not confirm

- **Which Ollama version and engine our M1 is running**, its unified memory size, and the
  `default_num_ctx` it logged. Needed to say which context tier applies and whether the error is
  possible at all (v0.34.1 or later).
- **Whether one `llama-server` SSE event equals one sampled token.** The check counts events;
  the equivalence was not verified in llama.cpp source.
- **What `llama-server` does when generation reaches the window with `--context-shift`.** Only
  Ollama's launch flags were read.
- **Which engine served `gpt-oss:20b` before v0.30.0**, and whether `repeat_penalty` applied to it
  then.
- **OpenAI-compatible mid-stream behaviour**: derived from reading `middleware/openai.go`; not run.
- **Whether our streaming client gets a 500 or a mid-stream error line** for this specific
  failure (depends on whether the harmony parser had flushed anything).
- **Any maintainer statement on root cause** of loops that trip the check. None found in the
  issues read (#8786, #17270, #18609, #18810, #12741).
- **A `gpt-oss`-specific report of this exact message.** None found; GitHub's issue search was not
  reachable, so web search was used instead, which is not exhaustive.
- **Whether OpenAI's model card (PDF) says anything about sampling or greedy decoding.** Not read;
  only the `openai/gpt-oss` README, the harmony guide and the Ollama cookbook article were.
- **The v0.34.1 release note** gives the rationale as fewer false positives; PR #18374's full
  discussion thread was read only through a page summary, so reviewer comments beyond what is
  quoted were not independently checked.
- **Reading was done with the `ollama` tag `v0.40.0`.** If the team runs a different tag, re-check
  `llm/llama_server.go` (or `llm/server.go` before v0.30.0) at that tag; the line numbers above
  will have moved.

---

## References

Ollama source (all at `v0.40.0` = `0d0720e51fb2fd9aa58781c3d720c06d720c2e7b` unless noted):

- Check and error:
  <https://github.com/ollama/ollama/blob/0d0720e51fb2fd9aa58781c3d720c06d720c2e7b/llm/llama_server.go#L1770-L1808>
- Pre-v0.30.0 location (`v0.20.0`):
  <https://github.com/ollama/ollama/blob/de9673ac3fb1c57fbf6e5e194f1f3dc5a8b48668/llm/server.go#L1632-L1664>
- Original introduction (PR #3080, commit `3e226112`):
  <https://github.com/ollama/ollama/pull/3080>
- Limit 100 plus returned error (PR #18374, commit `4512d2b7`):
  <https://github.com/ollama/ollama/pull/18374>
- Engine consolidation (PR #16031, commit `9db4bdba`):
  <https://github.com/ollama/ollama/commit/9db4bdbad6a4981ad761aa2b603e69e8fb83212c>
- Tiered default context (commit `0334ffa6`):
  <https://github.com/ollama/ollama/commit/0334ffa6250752c0e5e3d7f4467b0f50cc906fde>
- Repeat-penalty default 1.1 to 1.0 (commit `6a261db7`):
  <https://github.com/ollama/ollama/commit/6a261db7d87b13d76c5197cec636a0a3951afb36>
- Context shift default (PR #16712, commit `bbb40a0a`):
  <https://github.com/ollama/ollama/commit/bbb40a0a6c0cbca772182a8bfa426ed2f9c05ae2>
- Error responses, streaming: `server/routes.go` (`streamResponse` L2520, `writeChatResponse`
  L2841), `middleware/openai.go` (`ChatWriter.Write` L178), docs
  <https://github.com/ollama/ollama/blob/0d0720e51fb2fd9aa58781c3d720c06d720c2e7b/docs/api/errors.mdx>
- Docs: `docs/context-length.mdx`, `docs/faq.mdx`, `docs/modelfile.mdx`,
  `docs/api/openai-compatibility.mdx` (same tag)
- Release notes: <https://github.com/ollama/ollama/releases/tag/v0.34.1>,
  <https://github.com/ollama/ollama/releases/tag/v0.32.10>
- Library page: <https://ollama.com/library/gpt-oss:20b>

OpenAI:

- `gpt-oss` README, "Recommended Sampling Parameters":
  <https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/README.md#recommended-sampling-parameters>
- Harmony format guide:
  <https://github.com/openai/openai-cookbook/blob/main/articles/openai-harmony.md> (read from
  `main`; no commit pinned)

Issues and discussions (reports are secondary unless noted):

- <https://github.com/ollama/ollama/issues/1910>,
  <https://github.com/ollama/ollama/issues/8786>,
  <https://github.com/ollama/ollama/issues/17270>,
  <https://github.com/ollama/ollama/issues/18609>,
  <https://github.com/ollama/ollama/issues/18810>,
  <https://github.com/ollama/ollama/issues/12741>,
  <https://github.com/ollama/ollama/issues/11725>
- Third party: <https://github.com/berkayturanci/ai-jury/issues/857>,
  <https://github.com/vorojar/Folio-OCR/issues/12>,
  <https://github.com/NousResearch/hermes-agent/issues/43900>,
  <https://github.com/ggml-org/llama.cpp/discussions/15396>
