import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { isValidTimeZone } from '../services/cron-schedule.js';

loadDotenv();

// Per-model config on a provider — pricing plus sampling overrides. A
// model's own value here wins over the matching provider-level field below;
// unset on both means the underlying client's own default. `id` matches a
// requested model name by exact string equality only (no prefix/glob) — a
// provider with several tagged variants of the same base model
// (gpt-oss:20b, gpt-oss:120b) lists each explicitly. See
// docs/superpowers/specs/2026-10-14-per-model-sampling-pricing-config-design.md.
export const ModelConfigSchema = z.object({
  id: z.string(),
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  // Only forwarded for ollama/openai-type providers — Anthropic's API has no
  // seed parameter and ChatAnthropic exposes no such option.
  seed: z.number().int().optional(),
  // Ollama-only below — no OpenAI/Anthropic constructor or API equivalent
  // exists for any of these three (see createProviderFromConfig).
  numCtx: z.number().int().positive().optional(),
  topK: z.number().int().positive().optional(),
  repeatPenalty: z.number().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(ModelConfigSchema).optional(),
  // -1 = unlimited (bypasses the provider-queue gate entirely). Optional
  // rather than z.default(1) — a schema default would make this a required
  // key on the inferred ProviderConfig output type, breaking every existing
  // object literal built without it (provider-factory.test.ts,
  // providers.route.ts). Consumers (provider-queue.ts) fall back to 1
  // themselves, same pattern as defaultModel/apiKey above.
  maxConcurrency: z.number().int().optional(),
  // Bounds a single outbound LLM HTTP call (not a whole multi-tool-call
  // agent turn, which legitimately makes many bounded calls in sequence) —
  // the safety net for an interactive chat turn nobody ever explicitly
  // Stops. See docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md §6.
  // Optional for the same reason maxConcurrency is above.
  timeoutMs: z.number().int().optional(),
  // Sampling controls — the default every model on this provider falls back
  // to when it has no override of its own (see ModelConfigSchema above and
  // resolveEffectiveSampling in provider-factory.ts). Optional and inert
  // unless set: production chat leaves them to the provider's own defaults,
  // and only the eval CLI forces them (see applyEvalDeterminism in
  // provider-factory.ts).
  temperature: z.number().optional(),
  topP: z.number().optional(),
  // Only forwarded for ollama/openai-type providers — Anthropic's API has no
  // seed parameter and ChatAnthropic exposes no such option.
  seed: z.number().int().optional(),
  // Ollama-only below — same carve-out as ModelConfigSchema's.
  numCtx: z.number().int().positive().optional(),
  topK: z.number().int().positive().optional(),
  repeatPenalty: z.number().optional(),
  // Static headers sent with every outbound request this provider makes,
  // merged on top of whatever its auth mechanism sets (an explicit header
  // here wins on name collision). Applies to every provider type, including
  // the Azure OpenAI Provider below — see GLOSSARY.md "Custom Headers".
  headers: z.record(z.string(), z.string()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

// The OAuth2 Client Credentials Flow registration an Azure OpenAI Provider
// authenticates with — see GLOSSARY.md "Client Credentials"/"Access Token".
// `grantType` is free text sent verbatim as the token request's `grant_type`
// — no grant type other than 'client_credentials' is ever actually
// implemented (see ADR-0025/the design doc §5).
export const ClientCredentialsSchema = z.object({
  tokenUrl: z.string(),
  clientId: z.string(),
  // May arrive masked ('****') on a settings PATCH — resolved the same way
  // apiKey's mask sentinel is (see settings.handlers.ts's maskApiKey/unmaskApiKey).
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  grantType: z.string().default('client_credentials'),
});

export type ClientCredentials = z.infer<typeof ClientCredentialsSchema>;

// A separate schema, not more optional fields on ProviderSchema above — see
// ADR-0024. OIDC auth is also available on the OpenAI-Compatible Provider
// below (via `authMode`); `ollama`/`openai`/`anthropic` never gain
// `auth`/OIDC fields. Azure OpenAI is deployment-scoped rather than
// model-id-scoped, so
// `deploymentName` is this provider's one "model" (see GLOSSARY.md
// "Deployment Name") — there is no `defaultModel`/`baseUrl`/`apiKey` here.
export const AzureOpenAiProviderSchema = z.object({
  name: z.string(),
  type: z.literal('azure-openai'),
  endpoint: z.string(),
  deploymentName: z.string(),
  apiVersion: z.string(),
  auth: ClientCredentialsSchema,
  headers: z.record(z.string(), z.string()).optional(),
  // Same sampling/pricing shape every other provider already has, reused
  // as-is — models[] entries are keyed by deploymentName rather than a model
  // id, but ModelConfigSchema's shape doesn't care which string it is.
  models: z.array(ModelConfigSchema).optional(),
  maxConcurrency: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional(),
});

export type AzureOpenAiProviderConfig = z.infer<typeof AzureOpenAiProviderSchema>;

// The OpenAI-Compatible Provider: same OpenAI-wire-compatible request shape
// as the plain `openai` Provider (baseUrl + body-level model), but —
// unlike `openai` — selectable between a static API key and OIDC/OAuth2
// Client Credentials Flow auth via `authMode`. Distinct from the Azure
// OpenAI Provider, which is Azure-native on the wire and OIDC-only. See
// docs/superpowers/specs/2026-10-22-openai-compatible-oidc-provider-design.md.
//
// Defined as a plain object first, then wrapped in `.refine()` separately —
// `.refine()` returns a ZodEffects, which has no `.omit()`, and
// parseOpenAiCompatibleProvider below needs to omit `models` the same way
// parseAzureOpenAiProvider does.
const OpenAiCompatibleProviderObjectSchema = z.object({
  name: z.string(),
  type: z.literal('openai-compatible'),
  baseUrl: z.string(),
  defaultModel: z.string().optional(),
  authMode: z.enum(['apiKey', 'oidc']).default('apiKey'),
  apiKey: z.string().optional(), // required when authMode === 'apiKey'
  auth: ClientCredentialsSchema.optional(), // required when authMode === 'oidc'
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(ModelConfigSchema).optional(),
  maxConcurrency: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional(),
});

function hasRequiredAuthForMode(v: {
  authMode: 'apiKey' | 'oidc';
  apiKey?: string;
  auth?: unknown;
}) {
  return v.authMode === 'apiKey' ? v.apiKey !== undefined : v.auth !== undefined;
}

export const OpenAiCompatibleProviderSchema = OpenAiCompatibleProviderObjectSchema.refine(
  hasRequiredAuthForMode,
  {
    message:
      "openai-compatible provider requires 'apiKey' when authMode is 'apiKey', or 'auth' when authMode is 'oidc'",
    path: ['authMode'],
  },
);

export type OpenAiCompatibleProviderConfig = z.infer<typeof OpenAiCompatibleProviderSchema>;

// `providers[]`'s actual element type: the existing ProviderSchema or one of
// the two independently-shaped OIDC-capable Provider schemas — a union
// rather than a Zod discriminatedUnion, since every consumer already
// hand-narrows on `type` itself (see ADR-0024/the design doc §3 for why a
// true discriminated union buys nothing here).
export const AnyProviderSchema = z.union([
  ProviderSchema,
  AzureOpenAiProviderSchema,
  OpenAiCompatibleProviderSchema,
]);
export type AnyProviderConfig =
  ProviderConfig | AzureOpenAiProviderConfig | OpenAiCompatibleProviderConfig;

// A user-pinned provider/model pair, surfaced at the top of the chat
// Provider menu (issue #137). An ordered list rather than a Record — a
// favorite carries no value, and the user's order is meaningful.
export const FavoriteModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export type FavoriteModel = z.infer<typeof FavoriteModelSchema>;

// Keeps only well-formed entries, so one malformed hand-edited entry in
// config.yaml doesn't discard the rest (unlike getSection, which fails the
// whole section). Entries naming a provider that doesn't exist are kept —
// staleness is resolved by consumers, never a load error.
export function parseFavoriteModels(raw: unknown): FavoriteModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = FavoriteModelSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

// Same "drop only the malformed entry" philosophy as parseFavoriteModels
// above, but two levels deep: one bad models[] entry only drops that model
// (not the whole provider), and one bad provider only drops that provider
// (not the whole providers[] list). Used in place of
// configManager.getSection('providers', z.array(ProviderSchema)), whose
// all-or-nothing array validation would otherwise let a single hand-edit
// typo anywhere in providers[] silently empty the entire list (see the
// providers getter below). Uses console.warn, not the shared logger —
// logger.ts imports from this file, so logger.warn from here would be a
// circular import (see the timezone getter below for the same reasoning).
// Shared by both branches of parseProviders below — same "drop only the
// malformed model, not the whole provider" philosophy either schema uses.
function parseProviderModels(rawModels: unknown, providerName: string): ModelConfig[] | undefined {
  if (!Array.isArray(rawModels)) return undefined;
  return rawModels.flatMap((m) => {
    const parsed = ModelConfigSchema.safeParse(m);
    if (!parsed.success) {
      const id = (m as { id?: unknown })?.id;
      console.warn(
        `config: provider "${providerName}" model "${typeof id === 'string' ? id : '(no id)'}" has an invalid value — entry dropped`,
        parsed.error.issues,
      );
      return [];
    }
    return [parsed.data];
  });
}

function warnDroppedProvider(rest: Record<string, unknown>, issues: z.ZodIssue[]): void {
  const name = (rest as { name?: unknown }).name;
  console.warn(
    `config: provider "${typeof name === 'string' ? name : '?'}" is invalid — dropped`,
    issues,
  );
}

// Split into one function per concrete schema — rather than picking between
// the two with a ternary and calling .omit() on the result — because the
// two schemas' .omit() signatures don't unify through a shared variable:
// TS can't call a method through a union of two differently-shaped generic
// function types.
function parseStandardProvider(
  rest: Record<string, unknown>,
  rawModels: unknown,
): ProviderConfig[] {
  const base = ProviderSchema.omit({ models: true }).safeParse(rest);
  if (!base.success) {
    warnDroppedProvider(rest, base.error.issues);
    return [];
  }
  const models = parseProviderModels(rawModels, base.data.name);
  return [{ ...base.data, ...(models ? { models } : {}) }];
}

function parseAzureOpenAiProvider(
  rest: Record<string, unknown>,
  rawModels: unknown,
): AzureOpenAiProviderConfig[] {
  const base = AzureOpenAiProviderSchema.omit({ models: true }).safeParse(rest);
  if (!base.success) {
    warnDroppedProvider(rest, base.error.issues);
    return [];
  }
  const models = parseProviderModels(rawModels, base.data.name);
  return [{ ...base.data, ...(models ? { models } : {}) }];
}

// `.refine()` (hasRequiredAuthForMode) can't be applied through `.omit()` —
// it's re-checked by hand here after the plain-object parse succeeds, same
// "drop and warn" behavior as every other malformed-provider case in this
// file.
function parseOpenAiCompatibleProvider(
  rest: Record<string, unknown>,
  rawModels: unknown,
): OpenAiCompatibleProviderConfig[] {
  const base = OpenAiCompatibleProviderObjectSchema.omit({ models: true }).safeParse(rest);
  if (!base.success) {
    warnDroppedProvider(rest, base.error.issues);
    return [];
  }
  if (!hasRequiredAuthForMode(base.data)) {
    // Re-run the fully refined schema (including `models`, unlike `base`
    // above) purely to get a real ZodError describing the authMode
    // mismatch, for the same warn-and-drop shape every other malformed
    // provider case in this file uses.
    const refineCheck = OpenAiCompatibleProviderSchema.safeParse(rest);
    warnDroppedProvider(rest, refineCheck.success ? [] : refineCheck.error.issues);
    return [];
  }
  const models = parseProviderModels(rawModels, base.data.name);
  return [{ ...base.data, ...(models ? { models } : {}) }];
}

export function parseProviders(raw: unknown): AnyProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): AnyProviderConfig[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { models: rawModels, ...rest } = entry as Record<string, unknown>;
    switch ((rest as { type?: unknown }).type) {
      case 'azure-openai':
        return parseAzureOpenAiProvider(rest, rawModels);
      case 'openai-compatible':
        return parseOpenAiCompatibleProvider(rest, rawModels);
      default:
        return parseStandardProvider(rest, rawModels);
    }
  });
}

// The default IANA time zone used to resolve a cron schedule's timezone when
// a caller (e.g. the chat agent, which has no browser to prefill from) omits
// one. Falls back to 'UTC' for anything not a valid IANA zone name, rather
// than failing config load over a bad hand-edited value.
export function resolveServerTimezone(raw: unknown): string {
  return typeof raw === 'string' && isValidTimeZone(raw) ? raw : 'UTC';
}

export const DatabaseSchema = z.object({
  path: z.string().default('./app.db'),
});

export const ObservabilitySchema = z.object({
  enabled: z.boolean().default(true),
  spanOutputPreviewChars: z.number().default(500),
});

export const CostEntrySchema = z.object({
  inputPer1kTokens: z.number().default(0),
  inputScale: z.enum(['1k', '1M']).default('1k'),
  outputPer1kTokens: z.number().default(0),
  outputScale: z.enum(['1k', '1M']).default('1k'),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;

export const AfterAgentSchema = z.object({
  enabled: z.boolean().default(true),
});

// Opt-in, off by default (design spec §Q11): this app makes no outbound
// network call of its own accord. The Version Info system widget's "newer
// version available" check is the one thing that reads this.
export const UpdatesSchema = z.object({
  checkForUpdates: z.boolean().default(false),
});

export const ContextWindowSchema = z.object({
  enabled: z.boolean().default(true),
  // Floored well above MIN_BUDGET_FLOOR (chat-agent.ts) — a value this low
  // would leave the Turn Overflow recovery path (summary-boundary.ts) with
  // no realistic budget to recover into, making the feature this bounds
  // unusable rather than just conservative.
  maxTokens: z.number().min(4000).default(32000),
  // Fraction of maxTokens the trimmer actually targets — absorbs the char/4
  // estimator's systematic undercount on dense structured content (tool
  // schemas) without a second, separately-tuned calibration knob. See
  // docs/superpowers/specs/2026-09-04-context-window-tool-schema-overhead-design.md.
  safetyMarginPct: z.number().default(0.85),
});

export const ConversationSearchSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().default(20),
});

export const WorkspaceSummarySchema = z.object({
  enabled: z.boolean().default(true),
  messageThreshold: z.number().default(40),
});

// Whether an MCP tool's result that's too large to return inline gets the
// same toolStub/storeToolContent offload treatment web_fetch already gives
// its own oversized results — see #354.
export const McpToolStubSchema = z.object({
  enabled: z.boolean().default(true),
});

export const ChatSchema = z.object({
  showErrorMessages: z.boolean().default(false),
  codeBlockWrap: z.boolean().default(false),
  contextWindow: ContextWindowSchema.optional(),
  conversationSearch: ConversationSearchSchema.optional(),
  workspaceSummary: WorkspaceSummarySchema.optional(),
  mcpToolStub: McpToolStubSchema.optional(),
  // How many days since a chat thread's updatedAt before it's excluded from
  // the sidebar's own thread list (the Sidebar Retention Window — see
  // GLOSSARY.md). 0 disables this. Deliberately defaults to a non-zero
  // value, unlike this app's usual opt-in-by-default config convention —
  // see ADR-0030.
  sidebarRetentionDays: z.number().int().min(0).default(7),
});

// Config for the Kanban board's Done lane — deliberately named TaskBoardSchema
// rather than TasksConfigSchema (below), which is an unrelated section
// (env.workspaces.tasks.trackers — GitHub issue-tracker tokens) with a
// confusingly similar name.
export const TaskBoardSchema = z.object({
  // How many days since a Done-lane task's updatedAt before it's excluded
  // from the board's Done lane and the Inbox (the Done Lane Retention
  // Window — see GLOSSARY.md). 0 disables this. Deliberately defaults to a
  // non-zero value, unlike this app's usual opt-in-by-default config
  // convention — see ADR-0031 (mirrors chat.sidebarRetentionDays/ADR-0030).
  doneRetentionDays: z.number().int().min(0).default(5),
});

export const EmbeddingsSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.enum(['ollama', 'openai']).default('ollama'),
  model: z.string().default('nomic-embed-text'),
  baseUrl: z.string().default('http://localhost:11434/v1'),
  apiKey: z.string().optional(),
});

export const RLMConfigSchema = z.object({
  maxIterations: z.number().default(10),
  truncateThreshold: z.number().default(6000),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export type RLMConfig = z.infer<typeof RLMConfigSchema>;

// A named sub-agent "role" (spawn_sub_agent tool) — a fixed provider/model
// resolved server-side at dispatch time, never a parameter the calling model
// supplies. See docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §3.
export const RoleSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const RolesConfigSchema = z.record(z.string(), RoleSchema).default({});

export type RoleConfig = z.infer<typeof RoleSchema>;

// Loop guard — extends the recursion-guard middleware's step-count check-in
// with two signals that catch an agent repeating itself even while well
// under the step ceiling: stagnation (a tool returning materially the same
// output call after call) and a long unbroken streak of tool calls with no
// plain-text check-in (no repeats, but nothing pausing to explain itself
// either). See docs/superpowers/specs/2026-10-05-loop-guard-stagnation-reflection-design.md.
export const LoopGuardSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Consecutive same-tool/same-(normalized-)output calls before a cheap,
    // no-extra-LLM-call nudge is injected.
    stagnationNudgeThreshold: z.number().int().positive().default(3),
    // Same stagnation streak persisting past the nudge (it didn't help) ->
    // triggers the heavier reflection LLM call instead.
    stagnationReflectionThreshold: z.number().int().positive().default(5),
    // Consecutive tool-call turns, any tools, with zero repeats and no plain
    // reply in between -> also triggers reflection, independent of stagnation.
    streakReflectionThreshold: z.number().int().positive().default(10),
  })
  .refine((v) => v.stagnationReflectionThreshold > v.stagnationNudgeThreshold, {
    message: 'stagnationReflectionThreshold must be greater than stagnationNudgeThreshold',
    path: ['stagnationReflectionThreshold'],
  });

export type LoopGuardConfig = z.infer<typeof LoopGuardSchema>;

export const AgentSchema = z.object({
  recursionLimit: z.number().int().positive().default(100),
  recursionWarnThreshold: z.number().min(0.1).max(0.99).default(0.75),
  // A sub-agent run gets a much smaller hard ceiling than an interactive/task
  // agent. It now also carries the recursion-guard middleware itself (in
  // "throw" escalation mode — see recursion-guard.middleware.ts), so this
  // ceiling is a second, independent backstop underneath that, not the sole
  // protection it used to be.
  subAgentRecursionLimit: z.number().int().positive().default(25),
  loopGuard: LoopGuardSchema.default({
    enabled: true,
    stagnationNudgeThreshold: 3,
    stagnationReflectionThreshold: 5,
    streakReflectionThreshold: 10,
  }),
  // spawn_sub_agent Roles and which configured Role is the Default Role —
  // nested here rather than AppConfigSchema's root, same precedent as
  // subAgentRecursionLimit above. See ADR-0048-0053
  // (docs/adr/0047-*.md-0052-*.md) and GLOSSARY.md § Sub-Agent Roles.
  // No .refine() tying defaultRole to an existing roles key: the `agent`
  // getter below swallows any AgentSchema parse failure to bare defaults,
  // so a refine would risk silently wiping a user's entire agent section
  // over one stale defaultRole value. That invariant is enforced only
  // where it's mutated (routes/v1/roles.handlers.ts).
  roles: RolesConfigSchema,
  defaultRole: z.string().optional(),
});

export type AgentConfig = z.infer<typeof AgentSchema>;

export const ArtifactGcSchema = z.object({
  // How long a user-uploaded artifact must sit unreferenced before the
  // GC sweep will delete it — long enough that stepping away mid-compose
  // for a few hours doesn't lose a staged upload.
  graceMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  // How often the sweep runs — a separate knob from graceMs, since how
  // often to check and how old something must be are different concerns.
  intervalMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
});

export type ArtifactGcConfig = z.infer<typeof ArtifactGcSchema>;

// Governs every skill script execution path uniformly — the new runtime
// invocation (run_skill_script) and the existing test_skill_artifact
// authoring dry-run alike (ADR-0021: one setting, one behavior for "how
// long can a skill script run" rather than two different timeout concepts).
export const SkillsConfigSchema = z.object({
  scriptTimeoutMs: z.number().int().positive().default(300_000), // 5 minutes
});

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

export const WebFetchConfigSchema = z.object({
  timeoutMs: z.number().default(10000),
  respectRobotsTxt: z.boolean().default(true),
});

// Per-tool config.yaml entry — flat `tools.<toolId>` map (issue #171/#63/#154
// redesign; docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md
// §3). Every tool (built-in, wiki, skill-gated, mcp) can have an entry here;
// most won't. Generic fields cover the enable/default-include/description/
// instructions state every tool shares; the catchall carries the handful of
// tool-specific extra fields (web_fetch's timeoutMs/respectRobotsTxt,
// rlm_query's provider/model/maxIterations/truncateThreshold, shell_exec's
// allowlist/denylist) without a rigid nested schema — each is validated
// against its own typed schema only where it's actually written
// (tool-settings.handlers.ts), not here.
export const ToolDefaultIncludeSchema = z.object({
  chat: z.boolean().optional(),
  subAgent: z.boolean().optional(),
  autonomous: z.boolean().optional(),
});

export const ToolEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultInclude: ToolDefaultIncludeSchema.optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
  })
  .catchall(z.unknown());

export type ToolEntry = z.infer<typeof ToolEntrySchema>;

export const ToolsConfigSchema = z.record(z.string(), ToolEntrySchema).default({});

export const GithubTrackerSchema = z.object({
  token: z.string().optional(),
});

export const TrackersConfigSchema = z.object({
  github: GithubTrackerSchema.optional(),
});

export const TasksConfigSchema = z.object({
  trackers: TrackersConfigSchema.optional(),
});

// Authenticates git network operations (clone/fetch/sync/push) for
// workspaces and projects — deliberately separate from
// TasksConfigSchema's tracker token above, since one authenticates git
// itself and the other the GitHub issue-tracker API; a user who wants one
// PAT for both points both fields at the same ${ENV_VAR}.
export const GitCredentialsSchema = z.object({
  github: z.object({ token: z.string().optional() }).optional(),
});

export const WorkspacesSchema = z.object({
  git: GitCredentialsSchema.optional(),
  tasks: TasksConfigSchema.optional(),
});

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./wiki'),
  dashboardRoot: z.string().default('./dashboard'),
  mcpConfigDir: z.string().default('./mcp'),
  artifactRoot: z.string().default('./artifacts'),
  skillsRoot: z.string().default('./skills'),
  projectsRoot: z.string().default('./projects'),
  tempProjectsRoot: z.string().optional(),
  providers: z.array(AnyProviderSchema).default([]),
  defaultProvider: z.string().default(''),
  timezone: z.string().default('UTC'),
  // Per-IP cap on POST /api/v1/webhooks/tasks — that endpoint may be
  // exposed to the public internet, unlike the rest of this app's
  // currently-unauthenticated routes, so it needs its own brute-force/DoS
  // guard. See docs/superpowers/specs/2026-10-02-webhook-task-creation-design.md.
  webhookRateLimitPerMinute: z.number().default(60),
  // Deliberately loose: entries are validated one by one in
  // env.favoriteModels (parseFavoriteModels) so a single malformed
  // hand-edited entry can't fail config loading.
  favoriteModels: z.array(z.unknown()).default([]),
  database: DatabaseSchema.optional(),
  observability: ObservabilitySchema.optional(),
  afterAgent: AfterAgentSchema.optional(),
  updates: UpdatesSchema.optional(),
  chat: ChatSchema.optional(),
  taskBoard: TaskBoardSchema.optional(),
  embeddings: EmbeddingsSchema.optional(),
  agent: AgentSchema.optional(),
  artifactGc: ArtifactGcSchema.optional(),
  skills: SkillsConfigSchema.optional(),
  costs: z.record(z.string(), CostEntrySchema).default({}),
  tools: ToolsConfigSchema,
  workspaces: WorkspacesSchema.optional(),
});

// config.yaml is the primary config source. Use ${ENV_VAR} syntax in the file
// to reference environment variables. CONFIG_DIR overrides the config directory.
export const configManager = loadConfig({
  appName: 'amazing-hashbrown-api',
  schema: AppConfigSchema,
  configDir: process.env.CONFIG_DIR ?? './config',
  writeBack: true,
});

// Getter-based so values refresh automatically after configManager.reload().
export const env = {
  get port() {
    return configManager.getNumber('port', 3000) as number;
  },
  get logLevel() {
    return configManager.get('logLevel', 'info') as string;
  },
  get wikiRoot() {
    return configManager.getConfigDir(configManager.get('wikiRoot') as string);
  },
  get dashboardRoot() {
    return configManager.getConfigDir(configManager.get('dashboardRoot') as string);
  },
  get mcpConfigDir() {
    return configManager.getConfigDir(configManager.get('mcpConfigDir') as string);
  },
  get artifactRoot() {
    return configManager.getConfigDir(configManager.get('artifactRoot') as string);
  },
  get skillsRoot() {
    return configManager.getConfigDir(configManager.get('skillsRoot') as string);
  },
  get projectsRoot() {
    return configManager.getConfigDir(configManager.get('projectsRoot') as string);
  },
  get tempProjectsRoot() {
    const configured = configManager.get('tempProjectsRoot') as string | undefined;
    return configured || path.join(os.tmpdir(), 'projects');
  },
  get webhookRateLimitPerMinute() {
    return configManager.getNumber('webhookRateLimitPerMinute', 60) as number;
  },
  get providers(): AnyProviderConfig[] {
    // configManager.get() always String()-coerces its result (it's built for
    // scalar env-var-style values) — getSection() is the only accessor that
    // returns the raw, unstringified section, so it's used here (validated
    // only shallowly, against z.array(z.unknown())) purely to fetch the raw
    // array for parseProviders to validate entry-by-entry itself. Catches
    // both "providers key missing" and "providers isn't an array at all",
    // both of which getSection throws on.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (configManager as any).getSection('providers', z.array(z.unknown()));
      return parseProviders(raw);
    } catch {
      return [];
    }
  },
  get defaultProvider() {
    return (configManager.get('defaultProvider', '') ?? '') as string;
  },
  // The default timezone a cron schedule resolves to when its caller omits
  // one (see cron-config.ts). A present-but-invalid configured value warns
  // once per read and falls back to 'UTC' rather than failing to boot.
  get timezone(): string {
    const raw = configManager.get('timezone');
    if (typeof raw === 'string' && raw !== '' && !isValidTimeZone(raw)) {
      console.warn(`config: timezone "${raw}" is not a valid IANA time zone — using UTC`);
    }
    return resolveServerTimezone(raw);
  },
  get favoriteModels(): FavoriteModel[] {
    // Same configManager.get()-always-stringifies-arrays issue as
    // providers above — getSection() is the accessor that returns the raw,
    // unstringified section. Pre-existing bug (since PR #137): this getter
    // always returned [] against a real config.yaml.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (configManager as any).getSection('favoriteModels', z.array(z.unknown()));
      return parseFavoriteModels(raw);
    } catch {
      return [];
    }
  },
  get database(): z.infer<typeof DatabaseSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (configManager as any).getSection('database', DatabaseSchema) as z.infer<
        typeof DatabaseSchema
      >;
      return { ...raw, path: configManager.getConfigDir() + '/' + raw.path };
    } catch {
      return DatabaseSchema.parse({});
    }
  },
  get observability(): z.infer<typeof ObservabilitySchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('observability', ObservabilitySchema) as z.infer<
        typeof ObservabilitySchema
      >;
    } catch {
      return ObservabilitySchema.parse({});
    }
  },
  get afterAgent(): z.infer<typeof AfterAgentSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('afterAgent', AfterAgentSchema) as z.infer<
        typeof AfterAgentSchema
      >;
    } catch {
      return AfterAgentSchema.parse({});
    }
  },
  get updates(): z.infer<typeof UpdatesSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('updates', UpdatesSchema) as z.infer<
        typeof UpdatesSchema
      >;
    } catch {
      return UpdatesSchema.parse({});
    }
  },
  get chat(): z.infer<typeof ChatSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('chat', ChatSchema) as z.infer<typeof ChatSchema>;
    } catch {
      return ChatSchema.parse({});
    }
  },
  get taskBoard(): z.infer<typeof TaskBoardSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('taskBoard', TaskBoardSchema) as z.infer<
        typeof TaskBoardSchema
      >;
    } catch {
      return TaskBoardSchema.parse({});
    }
  },
  get embeddings(): z.infer<typeof EmbeddingsSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('embeddings', EmbeddingsSchema) as z.infer<
        typeof EmbeddingsSchema
      >;
    } catch {
      return EmbeddingsSchema.parse({});
    }
  },
  // web_fetch/rlm_query's config now lives at tools.web_fetch/tools.rlm_query
  // (closes issue #63 — no longer top-level, co-located with every other
  // tool's config) — these two getters keep the same narrow, convenient
  // shape their one-each call sites (web-fetch.ts, wiki-read-page.tool.ts,
  // rlm-query.tool.ts) already use, just repointed to the new location.
  get webFetch(): z.infer<typeof WebFetchConfigSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
      return WebFetchConfigSchema.parse(tools['web_fetch'] ?? {});
    } catch {
      return WebFetchConfigSchema.parse({});
    }
  },
  get rlm(): RLMConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
      return RLMConfigSchema.parse(tools['rlm_query'] ?? {});
    } catch {
      return RLMConfigSchema.parse({});
    }
  },
  get agent(): AgentConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('agent', AgentSchema) as AgentConfig;
    } catch {
      return AgentSchema.parse({});
    }
  },
  get artifactGc(): ArtifactGcConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('artifactGc', ArtifactGcSchema) as ArtifactGcConfig;
    } catch {
      return ArtifactGcSchema.parse({});
    }
  },
  get skills(): SkillsConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('skills', SkillsConfigSchema) as SkillsConfig;
    } catch {
      return SkillsConfigSchema.parse({});
    }
  },
  get costs(): Record<string, CostEntry> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection(
        'costs',
        z.record(z.string(), CostEntrySchema),
      ) as Record<string, CostEntry>;
    } catch {
      return {};
    }
  },
  // Raw per-tool config map, keyed by toolId — the resolver
  // (api/src/agents/tool-config.ts) is the only place that should read
  // arbitrary toolId entries out of this; other call sites needing one
  // specific tool's config (shell, web fetch, rlm) go through a narrower
  // convenience getter instead (see webFetch/rlm above, and shell_exec's
  // own read at its two call sites).
  get tools(): Record<string, ToolEntry> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
    } catch {
      return {};
    }
  },
  get workspaces(): z.infer<typeof WorkspacesSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('workspaces', WorkspacesSchema) as z.infer<
        typeof WorkspacesSchema
      >;
    } catch {
      return WorkspacesSchema.parse({});
    }
  },
};
