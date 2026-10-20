# Skill scripts run as a spawned process, not an in-process VM, for every language

`.py` scripts already spawn a real OS process and can be reliably killed; `.js`/`.mjs`/`.cjs` ran inside a Node `vm` context in the same process, whose own timeout option only interrupts synchronous code — an async script (a hung Promise, a timer) can't be force-stopped that way. Since scripts are now reachable during ordinary, unsupervised skill use rather than only while a human is watching `/create-skill`, every script type needs the same killable-on-timeout guarantee, so `.js` moves to a spawned process alongside `.py` and the new `.sh`.

## Consequences

`runScript`'s documented `context` argument (a live JS object injected into the script's globals) can no longer be passed that way — a spawned process shares no memory with its parent. It's preserved as a feature but now carries JSON-serializable data only, delivered to the script some other way (e.g. an env var it parses itself) instead of live object injection.
