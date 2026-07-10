# Manual Testing — PR #20: Connect ToolsManager to Chat Agent

These steps verify that:

- The `ToolsManager` boots cleanly on startup and its log line appears
- The `ask_user` and `upload_image` built-in tools are still available in the agent (regression check)
- MCP servers declared in `api/config/mcp.json` are loaded automatically at startup
- An unreachable MCP server at startup emits a warning but does not crash the process
- The `MCP_CONFIG_PATH` env var redirects where `mcp.json` is read from

---

## Prerequisites

- Node.js ≥ 20 and `npm install` completed at the repo root
- Ollama running locally with at least one model pulled, e.g.:
  ```sh
  ollama serve          # in a separate terminal if not already running
  ollama pull llama3    # only needed once
  ```
- A terminal in the **repo root**

---

## 1 — Start the dev server and confirm ToolsManager boot

```sh
npm run dev:api
```

**Expected — within the first few log lines you should see:**

```
[INFO] [amazing-hashbrown-api] ToolsManager booted {"configDir":"./config"}
[INFO] [amazing-hashbrown-api] API listening on port localhost:3000
```

- `api/config/mcp.json` is created automatically if it does not exist.
- No MCP-server lines appear yet (the file is empty by default), which is correct.

**If the boot line is missing** the `bootToolsManager()` call in `index.ts` is not running — check the console for an earlier error.

---

## 2 — Health check

```sh
curl -s http://localhost:3000/api/v1/health | jq
```

**Expected:**
```json
{ "status": "ok" }
```

---

## 3 — Basic chat (built-in tools regression)

Send a simple message and confirm the agent responds normally.

```sh
THREAD="$(node -e "console.log(crypto.randomUUID())")"

curl -sN -X POST http://localhost:3000/api/v1/chat/$THREAD \
  -H "Content-Type: application/json" \
  -d '{"content": "Reply with exactly the word HELLO and nothing else."}' 
```

**Expected — a stream of `data:` lines ending with:**

```
data: {"type":"text_delta","messageId":"...","delta":"HELLO"}
data: {"type":"stream_done","durationMs":...}
```

The `text_delta` events carry the model's reply. `stream_done` confirms the turn completed cleanly.

---

## 4 — `ask_user` built-in tool (HITL flow)

Ask the agent a question that forces it to use `ask_user`.

```sh
THREAD="$(node -e "console.log(crypto.randomUUID())")"

# Step 4a — send a message that triggers ask_user
curl -sN -X POST http://localhost:3000/api/v1/chat/$THREAD \
  -H "Content-Type: application/json" \
  -d '{"content": "Use the ask_user tool to ask me whether I prefer cats or dogs."}'
```

**Expected — stream includes a `hitl_prompt` event before `stream_done`:**

```
data: {"type":"hitl_prompt","messageId":"...","promptId":"...","question":"Do you prefer cats or dogs?","kind":"multiple_choice","choices":["Cats","Dogs"]}
data: {"type":"stream_done","durationMs":...}
```

```sh
# Step 4b — resume the conversation with the user's answer
curl -sN -X POST http://localhost:3000/api/v1/chat/$THREAD/hitl \
  -H "Content-Type: application/json" \
  -d '{"answer": "Cats"}'
```

**Expected — agent acknowledges the answer:**

```
data: {"type":"text_delta","messageId":"...","delta":"You prefer cats!"}
data: {"type":"stream_done","durationMs":...}
```

---

## 5 — MCP server: unreachable server warns but does not crash

Edit `api/config/mcp.json` to add a server that cannot connect:

```json
{
  "mcpServers": {
    "bad-server": {
      "command": "node",
      "args": ["/nonexistent/path/server.js"]
    }
  }
}
```

Restart the dev server (`Ctrl-C`, then `npm run dev:api` again).

**Expected startup logs:**

```
[INFO]  [amazing-hashbrown-api] ToolsManager booted {"configDir":"./config"}
[INFO]  [amazing-hashbrown-api] MCP servers configured: 1 {"servers":["bad-server"]}
[INFO]  [amazing-hashbrown-api] API listening on port localhost:3000
```

The server **starts normally**. The MCP connection is lazy — it is attempted when the agent first builds. Send any chat message and you will see the warning instead of a crash:

```
[WARN]  [amazing-hashbrown-api] MCP initialization failed — MCP tools will be unavailable {"err":...}
```

The agent still responds using built-in tools only.

Remove the bad server from `mcp.json` and restart before continuing.

---

## 6 — MCP server: real tools appear in the agent

This step uses the reference MCP filesystem server. Install it once:

```sh
npm install -g @modelcontextprotocol/server-filesystem
```

Edit `api/config/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp"
      ]
    }
  }
}
```

Restart the dev server. **Expected startup:**

```
[INFO] [amazing-hashbrown-api] ToolsManager booted {"configDir":"./config"}
[INFO] [amazing-hashbrown-api] MCP servers configured: 1 {"servers":["filesystem"]}
[INFO] [amazing-hashbrown-api] API listening on port localhost:3000
```

Send a message that invokes a filesystem tool:

```sh
THREAD="$(node -e "console.log(crypto.randomUUID())")"

curl -sN -X POST http://localhost:3000/api/v1/chat/$THREAD \
  -H "Content-Type: application/json" \
  -d '{"content": "List the files in /tmp using the available tools."}'
```

**Expected — stream includes `tool_call_start` and `tool_call_end` events for a filesystem tool** before the final text response:

```
data: {"type":"tool_call_start","toolName":"list_directory",...}
data: {"type":"tool_call_end",...}
data: {"type":"text_delta","messageId":"...","delta":"The files in /tmp are: ..."}
data: {"type":"stream_done","durationMs":...}
```

When you see `tool_call_start` for an MCP tool name (e.g. `list_directory`, `read_file`) the ToolsManager → agent wiring is confirmed end-to-end.

---

## 7 — `MCP_CONFIG_PATH` env var

Confirm the config path is redirectable without code changes.

```sh
# Create an alternate config file
mkdir -p /tmp/alt-config
echo '{"mcpServers":{}}' > /tmp/alt-config/mcp.json

MCP_CONFIG_PATH=/tmp/alt-config/mcp.json npm run dev:api
```

**Expected:**

```
[INFO] [amazing-hashbrown-api] ToolsManager booted {"configDir":"/tmp/alt-config"}
```

The `configDir` in the log reflects the directory derived from `MCP_CONFIG_PATH`. Revert to the default (no env var) to restore normal operation.

---

## Cleanup

Reset `api/config/mcp.json` to the default empty state when done:

```json
{
  "mcpServers": {}
}
```
