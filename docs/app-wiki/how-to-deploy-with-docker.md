## How to Deploy with Docker

The recommended way to run amazing-hashbrown is with Docker Compose using the pre-built image. No build step is required.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed on your machine.
- A directory on the host where persistent data will live (the guide uses `./data`).

### Step-by-Step Deployment

**1. Create the data directory**

The application runs as user ID 1001 (group 1001). The data directory must be owned by that UID before the container starts:

```bash
mkdir -p ./data
sudo chown -R 1001:1001 ./data
```

**2. Place your docker-compose.yml**

Put the `docker-compose.yml` file in the same directory as the `data/` folder you just created.

**3. Start the application**

```bash
docker compose up -d
```

**4. Edit the generated config**

On first boot the app writes a default `config.yaml` to `./data/`. Stop the container, open that file, add at least one LLM provider, then restart:

```bash
docker compose stop
# edit ./data/config.yaml
docker compose up -d
```

See [[How to Add a Provider]] for the provider config format. If you want to use a local Ollama instance, see [[How to Set Up Ollama]].

**5. Open the UI**

Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

### What Lives in `./data`

The bind mount (`./data:/app/config`) holds everything that persists across container restarts:

| Path | Contents |
|---|---|
| `config.yaml` | All application configuration |
| `app.db` | SQLite database (chat threads, traces, usage) |
| `wiki/` | Wiki pages organized by domain |
| `mcp.json` | MCP tool server definitions |
| `artifacts/` | Files produced by agent artifact tools |
| `skills/` | Custom skill files and slash commands |

### Included Runtimes

The Docker image includes several tools available to the agent's shell tool:

- `git`, `curl`, `python3`
- `gh` (GitHub CLI)
- `uv` and `uvx` (Python package runner)

These are available to the agent when it executes shell commands (subject to your approval). See [[config.yaml Overview]] for shell tool configuration options.

### Updating

Pull the latest image and restart:

```bash
docker compose pull
docker compose up -d
```

Config keys added in upgrades are merged into your existing `config.yaml` automatically on first boot of the new version.
