# `headersTimeout` is derived from `timeoutMs`, not an independently configurable field

Issue #402 traced undici's default 300s `Agent` `headersTimeout` to killing LLM requests on providers whose configured `timeoutMs` exceeds it. Rather than add a parallel `headersTimeoutMs` field to the provider schema, the fix derives the undici `Agent`'s `headersTimeout` from the provider's own already-configured `timeoutMs` at client-construction time in `createProviderFromConfig` — a provider with no `timeoutMs` set is left untouched, and there is no separate knob a user could set out of sync with `timeoutMs` and recreate the exact bug this fix exists to close.

## Consequences

A provider that wants a longer headers timeout without a longer overall request timeout has no way to express that; if that need ever arises, extend the derivation instead of reopening the "should this be its own field" question — the bug being fixed is specifically a too-short `headersTimeout` relative to `timeoutMs`, not a need for independently tuning the two.
