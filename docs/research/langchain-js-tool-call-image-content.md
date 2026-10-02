# Can a LangChain.js tool return an image the model actually sees?

**Scope:** `langchain` / `@langchain/core` (JS) only — `createAgent`, `ToolMessage`,
`@langchain/ollama`, `@langchain/openai`, `@langchain/anthropic`. Python LangChain's
multimodal tool support is unrelated and not covered here.

**Versions inspected (this repo's `node_modules` at time of writing):**

| Package                | Version |
| ---------------------- | ------- |
| `@langchain/core`      | 1.2.2   |
| `langchain`            | 1.5.2   |
| `@langchain/ollama`    | 1.3.0   |
| `ollama` (JS client)   | 0.6.3   |
| `@langchain/openai`    | 1.5.5   |
| `openai` (Node SDK)    | 6.45.0  |
| `@langchain/anthropic` | 1.5.1   |
| `@anthropic-ai/sdk`    | 0.103.0 |

Context for this research: `api/src/agents/tools/get-tool-key.tool.ts` +
`api/src/services/tool-content-store.ts` implement an on-demand "fetch offloaded
content" pattern for large **text**. The question is whether the same pattern can
be extended to **binary** (image) content by having `get_tool_key` return a
multimodal `ToolMessage`, or whether that's a dead end that needs a different
mechanism.

---

## 1. Does `ToolMessage` support multimodal content, and do the integrations forward it?

### 1a. `@langchain/core` type system

`ToolMessage`'s `content` field is not restricted to text at the type level.
`ToolMessageFields` extends `BaseMessageFields<TStructure, "tool">`
(`node_modules/@langchain/core/dist/messages/tool.d.ts:5-17`), and the general
"v1" content-block union (`ContentBlock.Standard`) is a **flat union across all
message types** — it includes `Multimodal.Standard` (`Image | Video | Audio |
PlainText | File`) with no per-role restriction in the type:

```ts
// node_modules/@langchain/core/dist/messages/content/index.d.ts:124
export type Standard = Text | Reasoning | NonStandard | Tools.Standard | Multimodal.Standard;
```

```ts
// node_modules/@langchain/core/dist/messages/content/multimodal.d.ts:62-65
type Image = Data & { readonly type: 'image' };
```

So **yes** — nothing in `@langchain/core`'s TypeScript types stops a tool from
constructing a `ToolMessage` whose `content` array contains an `{type: "image",
...}` block. The `message.d.ts` doc comment even uses `type: "human"` with an
`image` block as its v1 example, but the `ContentBlock.Standard` union itself is
not role-gated (`node_modules/@langchain/core/dist/messages/message.d.ts:1-45`).

This matches the official docs' framing of "standard content blocks" as a
provider-agnostic content model — the type system doesn't encode provider
wire-format constraints; that's left to each integration's converter. Which is
where the real answer lives:

### 1b. `@langchain/ollama` — **hard error**, not silent drop

```js
// node_modules/@langchain/ollama/dist/utils.cjs — convertToolMessageToOllama
function convertToolMessageToOllama(message) {
  if (typeof message.content !== 'string')
    throw new Error('Non string tool message content is not supported');
  return [{ role: 'tool', content: message.content }];
}
```

If a `ToolMessage`'s `content` is an array (which it must be to carry an image
block), `ChatOllama` **throws** before ever reaching the network. There is no
code path in this converter that even looks at block `type` — it rejects any
non-string tool content outright. This is the strictest of the three.

### 1c. `@langchain/openai` — depends on which code path runs; and OpenAI's own API only allows text in tool messages anyway

Two separate converters exist in `node_modules/@langchain/openai/dist/converters/completions.cjs`:

- **"v1 standard content" path** (`convertStandardContentMessageToCompletionsMessage`,
  used when `message.response_metadata.output_version === "v1"`): explicitly
  filters tool-role content to text blocks only — **silently drops** an image
  block:

  ```js
  // completions.cjs:477-480
  } else if (role === "tool" && ToolMessage.isInstance(message)) return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.contentBlocks.filter((block) => block.type === "text")
  };
  ```

  The function's own doc comment states this directly: _"tool: Returns only
  text content blocks with tool_call_id preserved"_ vs. _"user (default):
  Returns multi-modal content including text, images, audio, and files"_
  (completions.cjs, JSDoc above the function, ~line 408-413).

- **Legacy/v0 path** (`convertMessagesToCompletionsMessageParams`, the default
  for a hand-built `ToolMessage` that has no `output_version: "v1"` response
  metadata — i.e. exactly what a custom tool like `get_tool_key` would produce):
  this loop does **not** filter by role when it meets a LangChain "data content
  block" (`isDataContentBlock`) — it calls `convertToProviderContentBlock` and
  would emit an `image_url` part regardless of the message's role:

  ```js
  // completions.cjs:572-580
  const content = typeof message.content === "string" ? message.content : message.content.flatMap((m) => {
      if (isDataContentBlock(m)) return convertToProviderContentBlock(m, completionsApiContentBlockConverter);
      ...
  });
  ```

  So this path would actually **construct** a `{role: "tool", content: [{type:
"image_url", ...}], tool_call_id}` payload — something the real OpenAI API
  does not support (see below). This is not verified against a live OpenAI
  call, but it does not match OpenAI's documented/typed schema, so it would be
  expected to fail server-side (undocumented/unsupported combination), not
  silently succeed.

  **Confirmed from OpenAI's own Node SDK types** (the generated, canonical
  wire-schema source — `platform.openai.com/docs` itself 403'd a bare `curl`,
  so the SDK types are the authoritative artifact actually inspected here):

  ```ts
  // node_modules/openai/resources/chat/completions/completions.d.ts:1484-1497
  export interface ChatCompletionToolMessageParam {
      content: string | Array<ChatCompletionContentPartText>;   // TEXT ONLY
      role: 'tool';
      tool_call_id: string;
  }
  // :1502-1506
  export interface ChatCompletionUserMessageParam {
      content: string | Array<ChatCompletionContentPart>;        // full union incl. image_url
      role: 'user';
      ...
  }
  ```

  `ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartImage | ChatCompletionContentPartInputAudio | ChatCompletionContentPart.File`
  (completions.d.ts:894) — only `ChatCompletionUserMessageParam` is typed to
  accept that full union; `ChatCompletionToolMessageParam.content` is typed as
  text-only. This is the ground truth for Q3 below.

### 1d. `@langchain/anthropic` — **works correctly**

`@langchain/anthropic` is the one integration that both (a) understands
Anthropic's wire format has no standalone `tool` role, and (b) actually
forwards image content placed on a `ToolMessage`.

```js
// node_modules/@langchain/anthropic/dist/utils/message_inputs.cjs
// _ensureMessageContents(): a `tool`-type message becomes a HumanMessage
// wrapping a `tool_result` content block:
else updatedMsgs.push(new HumanMessage({ content: [{
    type: "tool_result",
    ...message.content != null ? { content: _formatContent(message) } : {},
    tool_use_id: message.tool_call_id
}] }));
```

`_formatContent` → `_formatContentBlocks` then explicitly recognizes both the
OpenAI-style `image_url` block and LangChain's standard `image` data-content
block and converts either into a proper Anthropic `{type: "image", source:
{...}}` block, nested inside that `tool_result`:

```js
// message_inputs.cjs (_formatContentBlocks)
if (contentPart.type === "image_url") { ... yield { type: "image", source, ... }; }
else if (contentPart.type === "image") { ... yield { type: "image", source, ... }; }
```

So **if** a tool constructs a `ToolMessage` with an `image_url` or standard
`image` content block, `@langchain/anthropic` will correctly produce a
`tool_result` block containing a nested Anthropic `image` block — matching
Anthropic's documented schema (§4 below) exactly.

### Summary table — ToolMessage → wire format

| Provider integration                   | Image in `ToolMessage.content`? | Behavior                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/ollama` `ChatOllama`       | ❌                              | Throws `Error("Non string tool message content is not supported")` for any non-string content — hard failure                                                                                                                  |
| `@langchain/openai` `ChatOpenAI`       | ❌                              | "v1" path: silently strips to text-only. Legacy path: would forward an `image_url` part into a `role: "tool"` payload that OpenAI's documented/typed schema doesn't support (expected to fail server-side; not live-verified) |
| `@langchain/anthropic` `ChatAnthropic` | ✅                              | Correctly rewrites the `ToolMessage` into a `tool_result` block inside a synthesized `user` message, with the image properly nested as an Anthropic `image` block                                                             |

**This alone rules out "just return a multimodal ToolMessage" as a
cross-provider solution** — it only works for Anthropic, hard-errors for
Ollama, and is unsupported/undocumented for OpenAI.

---

## 2. Ollama `/api/chat` — is `images` available on `role: "tool"` messages?

Source: `docs/api.md` on `github.com/ollama/ollama`, fetched directly
(`raw.githubusercontent.com/ollama/ollama/main/docs/api.md`).

The `/api/chat` message object is documented with a **flat, non-role-scoped**
field list:

```
### api.md:501-508
The `message` object has the following fields:
- `role`: the role of the message, either `system`, `user`, `assistant`, or `tool`
- `content`: the content of the message
- `thinking`: (for thinking models) the model's thinking process
- `images` (optional): a list of images to include in the message (for multimodal models such as `llava`)
- `tool_calls` (optional): a list of tools in JSON that the model wants to use
- `tool_name` (optional): add the name of the tool that was executed to inform the model of the result
```

`images` is **not explicitly scoped to `user`** in the prose. But:

- The only worked example with `images` in the whole doc is a `role: "user"`
  request (api.md:296-307, "Request (with images)" and the chat equivalent at
  api.md:960-988, "Chat request (with images)").
- The only worked example of a `role: "tool"` message (api.md:909-914, the
  "Chat request (With history, with tools)" example) has **no `images` field**
  — only `content` and `tool_name`:
  ```json
  { "role": "tool", "content": "11 degrees celsius", "tool_name": "get_weather" }
  ```

So the docs are **ambiguous by omission**: `images` is not textually forbidden
on a `tool` message, but it is never shown or endorsed there either.

To resolve the ambiguity I went to Ollama's actual server source
(`raw.githubusercontent.com/ollama/ollama/main/server/prompt.go`, fetched
directly). The function that turns each message's `Images` field into
rendered image tags, `imageTaggedMessages` (prompt.go:94), iterates
`msgs[start:]` and processes `msg.Images` **without checking `msg.Role`
anywhere in that loop** — the only `Role` check in the whole file is an
unrelated one for `"system"` in context-truncation logic (prompt.go:41).

**Conclusion:** at the Go server/templating-infrastructure level, Ollama does
not appear to special-case `images` by role — it would attempt to process
`images` on a `tool`-role message the same as any other. However:

- This is **not documented or exemplified** behavior; relying on it is relying
  on an implementation detail, not a contract.
- Whether the image is actually _inserted into the rendered prompt_ for a
  `tool`-role message still depends on each model's own chat template (a
  per-model Go/Jinja template), which is not something verifiable in general —
  this was not checked further and should be treated as **unconfirmed**.
- It's moot in practice for LangChain.js today: `@langchain/ollama` throws on
  non-string tool content before any of this would matter (§1b).

### Ollama `/api/chat` vs `/api/generate`, and which one `ChatOllama` uses

Confirmed directly from `@langchain/ollama` source
(`node_modules/@langchain/ollama/dist/chat_models.cjs:527,553`):

```js
const stream = await this.client.chat({ ... });
```

`ChatOllama` uses the **`ollama` npm client's `.chat()` method**, i.e. the
`/api/chat` endpoint — never `/api/generate`. `/api/generate`'s top-level
request-wide `images` array (`GenerateRequest.images`,
`node_modules/ollama/dist/shared/ollama.1bfa89da.d.ts`, the `GenerateRequest`
interface) is not used by this integration at all.

Separately, the `ollama` npm client's own TypeScript `Message` interface
(`node_modules/ollama/dist/shared/ollama.1bfa89da.d.ts`, `interface Message`)
types `role` as a bare `string` (not a role-discriminated union) and puts
`images?: Uint8Array[] | string[]` directly on that single interface with no
per-role variants — i.e. the **client library's types don't enforce any
role restriction either**, consistent with what the Go server source shows.

---

## 3. OpenAI Chat Completions — can `role: "tool"` contain `image_url` parts?

**No.** Confirmed from the official OpenAI Node SDK's generated types
(`node_modules/openai/resources/chat/completions/completions.d.ts`, OpenAI SDK
v6.45.0 — `platform.openai.com/docs/api-reference/chat/create` itself returned
HTTP 403 to a direct fetch, so the SDK's generated types, which mirror
OpenAI's OpenAPI spec, are the primary source actually used here):

```ts
// :1484-1497
export interface ChatCompletionToolMessageParam {
    content: string | Array<ChatCompletionContentPartText>;
    role: 'tool';
    tool_call_id: string;
}

// :1502-1510
export interface ChatCompletionUserMessageParam {
    content: string | Array<ChatCompletionContentPart>;
    role: 'user';
    ...
}
```

`ChatCompletionContentPart` (completions.d.ts:894) is the union that includes
`ChatCompletionContentPartImage`. Only the **user** message param is typed to
accept that union; the **tool** message param is typed to accept only
`ChatCompletionContentPartText`. Images are a `role: "user"`-only construct in
OpenAI's Chat Completions API.

---

## 4. Anthropic Messages API — do `tool_result` blocks support an `image` sub-block?

**Yes — explicitly and by design.** Two independent primary sources confirm
this:

**(a) Official SDK types** (`@anthropic-ai/sdk` v0.103.0,
`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1317-1326`):

```ts
export interface ToolResultBlockParam {
  tool_use_id: string;
  type: 'tool_result';
  cache_control?: CacheControlEphemeral | null;
  content?:
    | string
    | Array<
        | TextBlockParam
        | ImageBlockParam
        | SearchResultBlockParam
        | DocumentBlockParam
        | ToolReferenceBlockParam
      >;
  is_error?: boolean;
}
```

`ImageBlockParam` is a first-class member of `tool_result`'s content union.

**(b) Official docs** (`platform.claude.com/docs/...`, formerly
`docs.claude.com`, fetched directly):

- `agents-and-tools/tool-use/handle-tool-calls` gives the field-level spec and
  an exact worked example titled **"Example of tool result with images"**:

  ```json
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
        "content": [
          { "type": "text", "text": "15 degrees" },
          {
            "type": "image",
            "source": { "type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQSkZJRg..." }
          }
        ]
      }
    ]
  }
  ```

  The same page states the content options explicitly: _"a list of nested
  content blocks... These content blocks can use the `text`, `image`,
  `document`, or `search_result` types."_

- `build-with-claude/vision` independently corroborates this, discussing
  "images nested inside `tool_result` content (for example, screenshots
  returned to the computer use tool)" and a validation rule specific to that
  case: _"the API rejects a `tool_result` image that exceeds the model's
  limits with a validation error instead of downscaling it, so resize those
  images in your application before returning them."_

**Important structural note:** Anthropic's Messages API has **no top-level
`tool` role at all**. `tool_result` is a content-block type nested inside a
`role: "user"` message (and `tool_use` is a content-block type nested inside a
`role: "assistant"` message) — per `handle-tool-calls`: _"Unlike APIs that
separate tool use or use special roles like `tool` or `function`, the Claude
API integrates tools directly into the `user` and `assistant` message
structure."_ This is exactly what `@langchain/anthropic`'s `_ensureMessageContents`
(§1d) is doing when it rewrites a LangChain `ToolMessage` into a `HumanMessage`
wrapping a `tool_result` block — it's not a hack, it's matching Anthropic's
actual wire contract.

---

## 5. The working mechanism: middleware-based message injection

Given §1–4, a tool's own `ToolMessage` return value is **not** a viable
cross-provider mechanism for image delivery:

- Hard error on Ollama (`@langchain/ollama` throws for non-string content).
- Unsupported by OpenAI's actual API contract (tool messages are text-only;
  `@langchain/openai`'s modern path enforces this by stripping non-text
  blocks, and its legacy path would construct a payload OpenAI doesn't
  support).
- Works only for Anthropic, where `tool_result` blocks genuinely support
  nested `image` blocks and `@langchain/anthropic` forwards them correctly.

The one thing all three providers **do** agree on, with full, documented
support, is: **a `user`-role message can contain an image.**

- Ollama: documented and exemplified `images` field on `role: "user"`
  (api.md:296-307, 960-988).
- OpenAI: `ChatCompletionUserMessageParam.content` accepts
  `ChatCompletionContentPartImage` (completions.d.ts:1502-1506).
- Anthropic: `role: "user"` messages with `type: "image"` content blocks are
  the documented, canonical way to send vision input
  (`build-with-claude/vision`).

### Does `createMiddleware` expose a hook that runs after a tool call but before the next model call?

Yes. Inspected `node_modules/langchain/dist/agents/middleware.d.ts` and
`node_modules/langchain/dist/agents/middleware/types.d.ts` (package `langchain`
v1.5.2). `createMiddleware` exposes these lifecycle hooks:

| Hook            | When it runs                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeAgent`   | Once, at the very start of the agent invocation                                                                                                                  |
| `beforeModel`   | **Before every model invocation** — i.e., before the first call, and again before every subsequent call, including the one right after a round of tool execution |
| `wrapModelCall` | Wraps a single model invocation (can rewrite the request / response)                                                                                             |
| `wrapToolCall`  | Wraps a single tool invocation; handler returns `ToolMessage \| Command` — can "post-process tool results" and even return a `Command` for advanced control flow |
| `afterModel`    | After the model responds, **before** any tool calls it requested are executed                                                                                    |
| `afterAgent`    | Once, at the very end                                                                                                                                            |

The agent's built-in state explicitly includes the full message history as a
plain, mutable-via-update array:

```ts
// node_modules/langchain/dist/agents/runtime.d.ts:10-23
type AgentBuiltInState = {
  /**
   * Array of messages... Tool messages: Results from tool executions...
   * Messages are accumulated throughout the agent's lifecycle and can be
   * accessed or modified by middleware hooks during execution.
   */
  messages: BaseMessage[];
  ...
};
```

`beforeModel`'s handler type returns `MiddlewareResult<Partial<...>>`
(`middleware/types.d.ts:176`) — i.e. a partial state update, which can include
a `messages` update. Because `beforeModel` fires immediately before every
model call (including the one that follows a tool node's execution in the
standard LangGraph ReAct loop: model → tool(s) → **beforeModel** → model →
...), it is exactly "a hook that runs after a tool call but before the next
model call."

**So yes — injecting the image into a synthetic `HumanMessage` from a
`beforeModel` middleware hook is the correct, LangChain.js-supported
mechanism.** The flow for a `get_tool_key({ binary: true, ... })` call would
be: the tool itself still returns a plain/text `ToolMessage` (e.g. a stub
confirming the fetch), and a middleware's `beforeModel` hook inspects recent
messages for that marker and, if found, appends a new `HumanMessage` whose
content is the real `image` block — a message shape every one of the three
providers' integrations already converts correctly, because it's the exact
shape they use for ordinary user-supplied images.

`wrapToolCall` is a secondary candidate worth naming: it runs synchronously
around the tool call itself and can return a LangGraph `Command` (not just a
`ToolMessage`), which can also carry state updates. It's a plausible
alternative location to do the injection in the same "turn," but
`beforeModel` is the more direct match for "runs after a tool call but before
the next model call" and keeps the tool's own implementation simpler (the
tool doesn't need to know about `Command`).

This repo already has one `createMiddleware`-based pattern to follow:
`api/src/agents/skill-gated-tools.middleware.ts` uses `wrapModelCall` to
filter the tool list based on middleware state — the same
"composition over customization" shape (per `AGENTS.md`) would apply to a new,
separate middleware for binary-content injection, registered independently
rather than special-cased inside `get_tool_key` itself.

---

## Direct recommendation

**Route binary/image delivery through middleware-based message injection
(`beforeModel`), not through the tool's own `ToolMessage` return value.**

Reasoning, in order of weight:

1. `@langchain/ollama` **cannot** carry a multimodal `ToolMessage` at all — it
   throws. This alone eliminates the ToolMessage approach for an Ollama-backed
   deployment (which this harness explicitly supports and is likely the
   primary local model path).
2. OpenAI's Chat Completions API does not support images in tool-role messages
   at the schema level (confirmed via the official Node SDK types), and
   `@langchain/openai` either strips them (new path) or would emit a payload
   OpenAI doesn't document/support (legacy path).
3. Anthropic is the only provider where a multimodal `ToolMessage` would work
   correctly end-to-end today, via `@langchain/anthropic`'s `tool_result`
   rewriting — but building the feature around Anthropic-only behavior would
   silently break (Ollama) or do nothing useful (OpenAI) on the other two
   providers this repo targets.
4. A `beforeModel` middleware hook that injects a synthetic `HumanMessage`
   with a real `image` content block is the one approach that is uniformly,
   explicitly supported by all three providers' integrations, because it
   reuses the one message shape (`user` + image) every provider already
   handles correctly and routinely.

**What's confirmed vs. not:**

- Confirmed via source/types for all three providers: tool-result/tool-message
  image support (or lack thereof) — §1–4.
- Confirmed via source: `createMiddleware`'s `beforeModel` hook exists, runs
  before each model call, and can update the `messages` state array — §5.
- **Not fully confirmed:** whether Ollama's chat template rendering would
  actually surface an `images` field set on a `role: "tool"` message to the
  model even if `@langchain/ollama` didn't block it first — this depends on
  per-model Go/Jinja templates not inspected here, and is moot given point 1
  above blocks that path regardless.
- **Not live-tested:** whether OpenAI's API server actually rejects (vs.
  silently mishandles) an `image_url` part sent inside a `role: "tool"`
  message via the legacy `@langchain/openai` code path — inferred from the
  documented/typed schema only, not from an actual API call.
