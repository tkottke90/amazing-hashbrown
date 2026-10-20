# Revoke clears the cached token only; Rotate validates before persisting

#250's acceptance criteria list Revoke and Rotate as distinct UI actions, but a client-credentials Access Token has no standard IdP-side revocation endpoint to call. Revoke is scoped to what's actually possible: it clears the Azure OpenAI Provider's cached Access Token only, without touching its stored Client Credentials, forcing re-authentication on the next use. Rotate is the opposite shape — it changes `clientId`/`clientSecret` and is validated by fetching a fresh Access Token with the new values *before* the write is persisted; a failed fetch rejects the whole change rather than saving a bad secret and discovering it later.

## Consequences

Rotate needs no dedicated endpoint — it's the existing provider-edit Save path, which now fetches a token whenever `clientId`/`clientSecret` are part of the diff. Revoke does need a small new endpoint, since nothing about it changes stored config.
