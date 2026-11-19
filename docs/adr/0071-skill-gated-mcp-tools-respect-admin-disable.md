# Skill-Gated MCP tools still respect an admin's explicit disable

Extending Skill-Gated Tools (issue #409) to cover MCP tools, not just built-ins, raised whether a skill's own `tools` declaration should be as fully exempt from Tool Access as a built-in skill-gated tool is today (`create_workspace` binds whenever `create-workspace` is Active, full stop, regardless of any Tool Access setting). We decided it should not: an MCP tool that an admin has explicitly disabled (globally or per-thread) stays invisible even if some skill's `tools` field names it — the same invisibility contract `search_mcp_tools`/`use_mcp_tools` already give disabled MCP tools (ADR-0067) applies here too, rather than an exception to it.

Built-in tools are shipped and vetted with the app; MCP tools are third-party and get disabled for real operational reasons (cost, flakiness, a server misbehaving) that a skill author has no visibility into and shouldn't be able to silently override. This makes gating asymmetric by tool source — a deliberate, surprising-without-this-note divergence from the built-in exemption, not an oversight.

**Considered and rejected**: full exemption, matching built-in skill-gated tools exactly, for mechanism uniformity. Rejected because it would let any app-level skill re-enable an MCP tool an admin turned off, for a reason the skill has no way to know about.
