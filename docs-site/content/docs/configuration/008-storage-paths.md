---
title: Storage Paths
section: Configuration
order: 9
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Storage Paths

Where the application keeps everything it reads and writes on disk. Every path below except `tempProjectsRoot` is resolved relative to the directory that holds `config.yaml`.

| Key                | Type   | Default                    | Description                                                                                                                                       |
| ------------------- | ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `wikiRoot`          | string | `"./wiki"`                   | Root of the knowledge-base directory tree — see [LLM Wiki](/docs/llm-wiki/).                                                                      |
| `mcpConfigDir`      | string | `"./mcp"`                    | Directory holding `mcp.json` and other MCP server runtime config.                                                                                 |
| `artifactRoot`      | string | `"./artifacts"`              | Where uploaded and agent-generated artifacts (images, files) are stored, one subdirectory per artifact.                                           |
| `skillsRoot`        | string | `"./skills"`                 | Directory of Agent-Skills-format skill folders (each a `SKILL.md` plus instructions). Created automatically on first boot.                        |
| `projectsRoot`      | string | `"./projects"`               | Where a new workspace/project is created when its location is set to "Projects" in the New Workspace form.                                       |
| `tempProjectsRoot`  | string | OS temp dir + `/projects`    | Where a workspace/project is created when its location is set to "Temporary". **Not** relative to the config directory — use an absolute path if you override it. |

{% call code(language="yaml") %}
wikiRoot: ./config/kb
mcpConfigDir: ./config
artifactRoot: ./config/artifacts
skillsRoot: ./skills
projectsRoot: ./projects
{% endcall %}
