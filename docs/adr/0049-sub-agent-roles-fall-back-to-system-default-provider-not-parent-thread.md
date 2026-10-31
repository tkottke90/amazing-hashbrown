# A Role with no provider/model falls back to the system default, not the calling thread's provider

A Role's `provider`/`model` are already optional and fall back to the system default provider/model (`createProvider()`'s existing behavior) when unset — this includes the Default Role. We considered instead inheriting the *calling parent thread's* resolved provider/model (which can differ from the system default via a per-thread override), but that defeats the sub-agent design's overspend guard (`docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md` §1): a thread deliberately pinned to a paid provider would silently make every default-role sub-agent paid too, with no config entry a user could point to as the cause.

A follow-up enhancement — richer per-scenario provider/model controls and a possible routing heuristic for sub-agent dispatch — is tracked separately rather than folded into this feature.
