# Reserve `system` as a Widget Source with no producer yet

The #176 design mockup's provenance badge shows three sources — Manual, Agent, System — but #315 (the agent/CLI write API) only ever produces `manual` or `agent` writes; `system` is meant for application-collected metadata nobody asked for, which nothing in #315 generates. We reserve the `system` literal in the `Widget Source` type now, so adding it later needs no breaking type change, but ship no selector, no producer, and no UI rendering for it. The actual feature — which metrics, what triggers an update — is tracked separately in #320.

## Considered Options

- Leave `system` out of the type entirely until #320 lands — rejected: #320 would then need to widen a type every other call site already pattern-matches on, for a one-line addition that costs nothing to reserve now.
- Build a minimal real producer as part of #315 — rejected: scope creep; #315 is about external write surfaces (agent, CLI), and `system` is explicitly _not_ an external write surface.
