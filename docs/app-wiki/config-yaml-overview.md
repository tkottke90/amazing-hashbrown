## config.yaml Overview

All application configuration lives in a single file, `config.yaml`, inside the config directory. By default this is `./config` on the host (or `./data` when using the Docker setup). You can override the path with the `CONFIG_DIR` environment variable.

### Auto-Generation and Auto-Update

If `config.yaml` does not exist when the app starts, it is created automatically with sensible defaults. When an upgrade adds new configuration keys, those keys are merged into your existing file on first boot of the new version — your customizations are preserved. This behavior is controlled by the `writeBack: true` setting (on by default).

### Environment Variable Interpolation

Any string value in `config.yaml` can reference an environment variable using `${VAR_NAME}` syntax:

```yaml
apiKey: ${ANTHROPIC_API_KEY}
```

This keeps secrets out of the config file itself while still supporting file-based configuration.

### Top-Level Sections

| Section           | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `providers`       | LLM backends (Ollama, OpenAI, Anthropic). See [[How to Add a Provider]]         |
| `embeddings`      | Embedding model used for wiki search and retrieval                              |
| `database`        | SQLite database path and settings                                               |
| `observability`   | Tracing and span recording. See [[Observability Configuration]]                 |
| `afterAgent`      | Background knowledge extraction pipeline. See [[AfterAgent Configuration]]      |
| `chat`            | Chat behavior defaults                                                          |
| `rlm`             | Retrieval Loop Model settings. See [[Retrieval Loop Model (RLM) Configuration]] |
| `webFetch`        | Controls the `web_fetch` tool. See [[Web Fetch Configuration]]                  |
| `tools.shell`     | Shell tool settings (approval flow, allowed commands)                           |
| `mcpConfigDir`    | Path to the MCP tool server configuration                                       |
| `wikiRoot`        | Root directory where wiki pages are stored                                      |
| `artifactRoot`    | Directory for agent-generated artifact files                                    |
| `skillsRoot`      | Directory for skill files and slash commands                                    |
| `defaultProvider` | Name of the provider used for new chat threads                                  |
| `port`            | HTTP port the app listens on (default: 3000)                                    |
| `logLevel`        | Logging verbosity (`debug`, `info`, `warn`, `error`)                            |
| `costs`           | Per-model token pricing. See [[Cost Rates Configuration]]                       |

### Editing the Config

You can change settings two ways:

- **Settings UI**: open the browser UI and go to **Settings**. Most common options are available here, and changes take effect immediately without a restart.
- **Direct file edit**: open `./data/config.yaml` in any text editor. Most settings are reloaded by the API in-memory — a full container restart is not required for the majority of changes.

### What Must Exist Before First Boot

The config directory itself must exist and be writable before the app starts. Everything else — the database, wiki directory, artifact directory, and config file — is created automatically on first run.

See [[How to Deploy with Docker]] for the recommended directory setup.
