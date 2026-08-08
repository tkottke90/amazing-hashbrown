## How to Set Up Ollama

[Ollama](https://ollama.ai) lets you run large language models entirely on your own hardware — no API keys, no internet required after the initial model download.

### Install Ollama

Download and install Ollama from [ollama.ai](https://ollama.ai). The installer is available for macOS, Linux, and Windows.

After installation, Ollama runs as a background service and listens at `http://localhost:11434` by default.

### Pull a Model

Open a terminal and pull any model you want to use:

```bash
# A capable general-purpose model
ollama pull llama3.1

# Lighter weight, fast on modest hardware
ollama pull qwen2.5:7b

# Good for coding tasks
ollama pull qwen2.5-coder:7b
```

You can see all available models at [ollama.com/library](https://ollama.com/library). Larger models (70B+) need more VRAM or RAM; 7B–14B models run well on most modern laptops with 16 GB of memory.

### Configure amazing-hashbrown to Use Ollama

Open `./data/config.yaml` and add an Ollama provider under the `providers` key:

```yaml
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3.1
```

Then set it as the default provider:

```yaml
defaultProvider: local
```

Restart the container (or reload via Settings) for the change to take effect. See [[How to Add a Provider]] for the full provider configuration format and how to add multiple providers.

### Running Inside Docker

If amazing-hashbrown is running in Docker and Ollama is installed on the host machine, `localhost` inside the container refers to the container itself — not your host. Use the special Docker DNS name instead:

```yaml
baseUrl: http://host.docker.internal:11434
```

On Linux, `host.docker.internal` may not resolve automatically. You can add it to the container's `/etc/hosts` or use your host's LAN IP address (e.g., `http://192.168.1.x:11434`).

### Embeddings with Ollama

The wiki search and retrieval features use an embeddings model. To use a local embedding model, pull one and set it in the `embeddings` section of `config.yaml`:

```bash
ollama pull nomic-embed-text
```

```yaml
embeddings:
  provider: local
  model: nomic-embed-text
```

### Verifying the Connection

After configuring, open the Settings UI in amazing-hashbrown (Settings → Model Providers). Your Ollama provider should appear with a green status indicator if the connection is healthy.
