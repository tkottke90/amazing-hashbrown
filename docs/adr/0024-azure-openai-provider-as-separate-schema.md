# Azure OpenAI Provider gets its own schema, not more optional fields on ProviderSchema

Adding OIDC support (#250) required `endpoint`/`deploymentName`/`apiVersion`/`tokenUrl`/`clientId`/`clientSecret`/`scope`/`grantType` fields that have no meaning for `ollama`/`openai`/`anthropic` providers. Rather than bolt these on as more optional fields on the existing `ProviderSchema` — growing it into exactly the escape-hatch "bag" schema this repo's Composition over Customization principle warns against — `providers[]` entries are a union: the existing `ProviderSchema` (structurally unchanged, aside from gaining an unrelated `headers` field used by every provider type) plus a new, separate schema for the Azure OpenAI Provider, discriminated by `type`.

## Consequences

`createProviderFromConfig` and anything else that switches on `type` gets a new case with its own, independently-typed branch instead of a pile of `azure-openai`-only optional fields every other branch has to ignore. A future provider type with its own unrelated shape follows the same pattern rather than widening the shared schema further.
