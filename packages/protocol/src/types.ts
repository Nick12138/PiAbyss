import type { HostError, JsonValue } from "./errors.js";

export type HostIdentity = {
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
  packageRevision: number;
};

export type HostCapabilities = {
  packageUpdateCheck: boolean;
  extensionUi: true;
  sessionExport: boolean;
};

/** Safe, bounded status projection published by pi-subagents for the active Pi session. */
export type SubagentStatusState =
  "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";

export type SubagentStatusActivity = {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
};

export type SubagentStatusNode = {
  id: string;
  kind: "subagent" | "workflow" | "step";
  label: string;
  /** Human-readable task/session name when one is available. */
  name?: string;
  /** Configured agent role when the status source exposes it. */
  role?: string;
  /** Model used by the run when the status source exposes it. */
  model?: string;
  /** Effective thinking level the run was spawned with (unset means pi's
   *  global default thinking level applies). */
  thinking?: string;
  state: SubagentStatusState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: SubagentStatusActivity;
  children?: SubagentStatusNode[];
};

/** Read-only projection of a child Pi session. Entries use the same shape as
 * the primary SessionSnapshot so the desktop can reuse its transcript model. */
export type SubagentSessionSnapshot = {
  nodeId: string;
  sessionId: string;
  name?: string;
  state: SubagentStatusState;
  entries: SerializableSessionEntry[];
  truncated: boolean;
  updatedAt: number;
};

export type SubagentFleetEntry = {
  key: string;
  agent: string;
  role?: string;
  model?: string;
  effort?: string;
  startedAt: number;
  tokens: { input: number; output: number; total: number };
  goal?: string;
};

export type SubagentsStatusSnapshot = {
  version: 1;
  available: boolean;
  generatedAt: number;
  totalActive: number;
  omitted: number;
  fleet: SubagentFleetEntry[];
  runs: SubagentStatusNode[];
};

/** Stage an interrupted provider mutation had reached. */
export type ProviderMutationStage = "prepared" | "committed";

export type ModelConfigHealth = {
  /**
   * `degraded` means an interrupted provider mutation could not be fully
   * rolled back. The configuration may mix old and new state, so the Host must
   * not claim it is healthy.
   */
  state: "ok" | "error" | "degraded";
  source: "ModelRegistry.getError" | "provider.journal";
  message?: string;
  migrationHint?: {
    code: "SESSION_AFFINITY_FORMAT_REQUIRED";
    message: string;
  };
  /** Present only while a provider mutation journal is unresolved. */
  recovery?: {
    journalId: string;
    stage: ProviderMutationStage;
    /** False when models.json or the credential file could not be restored. */
    restored: boolean;
  };
};

export type HostPhase =
  | "booting"
  | "waitingForWorkspace"
  | "ready"
  | "agentBusy"
  | "packageBusy"
  | "reloading"
  | "workspaceError"
  | "shuttingDown"
  | "fatal";

/** One workspace graph currently bound to (active or parked in) the Host. */
export type BoundWorkspaceRef = {
  workspaceId: string;
  /** The graph's current revision; events from this workspace carry it. */
  revision: number;
  /** Canonical workspace directory for cwd-based matching. */
  cwd: string;
};

export type HostStatusSnapshot = HostIdentity & {
  protocolVersion: 1;
  sdkVersion: string;
  nodeVersion: string;
  agentDir: string;
  phase: HostPhase;
  capabilities: HostCapabilities;
  modelConfigHealth: ModelConfigHealth;
  extensionDecisionPresentation?: ExtensionDecisionPresentation;
  lastError?: HostError;
  fatalError?: HostError;
  /**
   * Every workspace graph bound to this Host (the active one plus parked
   * retained graphs), present on shared-host Hosts. Lets clients accept
   * workspace-scoped events from parked graphs and map workspaceId → cwd.
   */
  boundWorkspaces?: BoundWorkspaceRef[];
};

export type WorkspaceSnapshot = {
  id: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  servicesReady: boolean;
};

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  symlink: boolean;
};

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "conflicted";

export type GitFileChange = {
  path: string;
  originalPath?: string;
  staged: GitChangeKind | null;
  unstaged: GitChangeKind | null;
  conflict: boolean;
  submodule: boolean;
  pathSupported: boolean;
};

export type GitStatusSnapshot =
  | {
      state: "ready";
      revision: number;
      repositoryRoot: string;
      workspaceIsRepositoryRoot: boolean;
      branch: string | null;
      detached: boolean;
      unborn: boolean;
      headSha: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      indexGeneration: string;
      files: GitFileChange[];
      warnings: string[];
    }
  | { state: "not_repository"; revision: number }
  | { state: "unavailable"; revision: number; message: string }
  | { state: "error"; revision: number; message: string };

export type GitDiffSnapshot = {
  path: string;
  area: "staged" | "unstaged";
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  contentGeneration: string;
  hunks: GitDiffHunk[];
  hunkOperations: GitHunkOperation[];
};

export type GitDiffHunk = {
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
};

export type GitHunkOperation = "stage" | "unstage" | "discard";

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
};

export type GitBranchList = {
  statusRevision: number;
  current: string | null;
  detached: boolean;
  branches: GitBranch[];
  truncated: boolean;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authoredAt: string;
  subject: string;
  refs: string[];
};

export type GitHistoryResult = {
  commits: GitCommitSummary[];
  nextCursor: string | null;
};

export type GitCommitDiffSnapshot = {
  commitSha: string;
  parentSha: string | null;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
};

export type GitMutationResult = {
  applied: true;
  snapshot?: GitStatusSnapshot;
  warning?: string;
};

/**
 * Acknowledgement for asynchronous git mutations (pull/push). The request
 * returns immediately; the actual result arrives later via the
 * `git.taskFinished` event carrying the same `taskId`.
 */
export type GitAsyncAccepted = {
  accepted: true;
  taskId: string;
  /** Absolute workspace path the task runs against (from the graph's canonical cwd). */
  workspaceCwd: string;
};

/** Outcome of one asynchronous git task, emitted to the requesting workspace identity. */
export type GitTaskFinishedPayload = {
  taskId: string;
  /** "pull" or "push" — enough for the UI to phrase the notification. */
  operation: "pull" | "push";
  /** Human-readable workspace label (canonical cwd basename). */
  workspaceName: string;
  ok: boolean;
  /** User-facing failure message when `ok` is false (already localized server-side? no — raw git error). */
  error?: string;
  errorKind?: "conflict" | "diverged" | "clean-worktree" | "network" | "auth" | "other";
  snapshot?: GitStatusSnapshot;
};

export type GitCommitResult = GitMutationResult & {
  commitSha: string | null;
};

export type GitCommitMessageResult = {
  /** Suggested commit message written by the model. */
  message: string;
  /** True when the staged diff was truncated before it reached the model. */
  truncated?: boolean;
  /** True when the model produced no usable text and the message was derived from the staged patch instead. */
  fallback?: boolean;
};

export type SessionSummary = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  cwd: string;
  /** Creation time in epoch milliseconds (from the session file's created date). */
  createdAt?: number;
  updatedAt: number;
  messageCount?: number;
  archived?: boolean;
  runtimeState?: SessionRuntimeState;
  sessionRevision?: number;
};

export type SessionRuntimeState = "starting" | "running" | "queued" | "idle" | "error" | "inactive";

export type ModelSummary = {
  provider: string;
  /** Human-readable Provider (vendor) display name, e.g. "天机阁". Falls back to `provider`. */
  providerName?: string;
  modelId: string;
  name: string;
  thinkingLevels?: string[];
  /** Which input modalities the model accepts. Present on `piSettings.get`
   *  snapshots so clients can filter e.g. vision-capable models. */
  input?: Array<"text" | "image">;
};

export type ProviderApi =
  "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type PiSettingsModel = ModelSummary;

export type PiSettingsSnapshot = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel: ThinkingLevel;
  retryMaxRetries: number;
  defaultProjectTrust: "ask" | "always" | "never";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  /** Built-in tools enabled for new sessions; omitted means pi's own defaults. */
  defaultTools?: string[];
  /** HTTP(S) proxy URL the Host applies process-wide at startup; omitted means none. */
  httpProxy?: string;
  models: PiSettingsModel[];
};

export type PiSettingsPatch = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  retryMaxRetries?: number;
  defaultProjectTrust?: "ask" | "always" | "never";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  defaultTools?: string[];
  /** HTTP(S) proxy URL to persist; an empty string clears the setting. */
  httpProxy?: string;
};

/** Scope of a settings-configured skill path (mirrors Settings scopes). */
export type SkillSettingsScope = "user" | "project";

/** A single skill discovered by Pi's resource loader. */
export type SkillInfo = {
  name: string;
  description: string;
  /** SKILL.md (or standalone .md) file path. */
  filePath: string;
  /** Directory the skill resolves relative paths against. */
  baseDir: string;
  /** Loader source label (e.g. "user", package name). */
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  /** Owning package install path when origin is "package". */
  packagePath?: string;
  /** Hidden from the system prompt; only invocable via /skill:<name>. */
  disableModelInvocation: boolean;
};

export type SkillDiagnostic = {
  severity: "warning" | "error" | "collision";
  message: string;
  path?: string;
};

/** A `skills` entry found in a settings.json file (user or project). */
export type SkillConfiguredPath = {
  path: string;
  scope: SkillSettingsScope;
  /** Whether the configured path currently exists on disk (after resolution). */
  exists: boolean;
};

export type SkillSnapshot = {
  revision: number;
  workspaceId: string;
  /** Workspace cwd the discovery ran against. */
  cwd: string;
  /** Whether Pi loads project-local resources for this workspace. */
  projectTrusted: boolean;
  skills: SkillInfo[];
  diagnostics: SkillDiagnostic[];
  /** Raw `skills` arrays from user and project settings.json. */
  configuredPaths: SkillConfiguredPath[];
  resourceReloadRequired: boolean;
};

export type SkillPathMutation = {
  path: string;
  scope: SkillSettingsScope;
};

/**
 * Optional cross-workspace targeting for skill/package/prompt management
 * methods. Omitting both fields targets the active workspace. Only one of the
 * two may be set; the Host resolves the id against its bound-workspace list
 * and canonicalizes the cwd, so the renderer can pass the raw known-workspace
 * path even when the workspace has never been bound this Host session.
 */
export type WorkspaceTargetRef = {
  targetWorkspaceId?: string;
  targetWorkspaceCwd?: string;
};

/** Kind of a discovered prompt file (matching Pi's loader roles). */
export type PromptKind = "system" | "append" | "context";

export type PromptInfo = {
  /** File name, e.g. "SYSTEM.md". */
  name: string;
  kind: PromptKind;
  scope: "user" | "project";
  filePath: string;
  /** Whether Pi actually loads this file for the current workspace. */
  loaded: boolean;
};

export type PromptSnapshot = {
  revision: number;
  workspaceId: string;
  /** Workspace cwd the discovery ran against. */
  cwd: string;
  /** Global agent directory containing user-scope prompt files. */
  agentDir: string;
  projectTrusted: boolean;
  /** Only prompt files that exist on disk. */
  prompts: PromptInfo[];
};

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export type ProviderModelConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export type DiscoveredProviderModel = ProviderModelConfig & {
  enabled: boolean;
  thinkingSource: "provider" | "profile" | "inferred" | "configured" | "manual" | "default";
};

export type ProviderAuthStatus = {
  configured: boolean;
  source?:
    "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
  /** Masked preview of the stored key, e.g. "sk-a.......wxyz"; absent when unavailable. */
  maskedKey?: string;
};

export type ProviderCompatibility = {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
};

export type ProviderCompatibilityDraft = {
  supportsDeveloperRole?: boolean | null;
  supportsReasoningEffort?: boolean | null;
};

export type ProviderSnapshot = {
  id: string;
  enabled: boolean;
  name: string;
  baseUrl: string;
  modelsUrl?: string;
  api: ProviderApi;
  authHeader: boolean;
  headers: Record<string, string>;
  compat?: ProviderCompatibility;
  models: ProviderModelConfig[];
  auth: ProviderAuthStatus;
};

export type ProviderDraft = Omit<ProviderSnapshot, "auth" | "enabled" | "compat" | "authHeader"> & {
  /** Rolling-compatibility hint for Hosts that predate automatic auth selection. */
  authHeader?: boolean;
  compat?: ProviderCompatibilityDraft;
};

/** Login-capable builtin (SDK) provider and its credential state. */
export type BuiltinProviderAuthStatus = {
  providerId: string;
  name: string;
  supportsOauth: boolean;
  /** Subscription label from the SDK, e.g. "Anthropic (Claude Pro/Max)". */
  oauthLabel?: string;
  supportsApiKeyLogin: boolean;
  configured: boolean;
  /** Human-readable auth source, e.g. "OAuth" or "ANTHROPIC_API_KEY". */
  authLabel?: string;
  /** True when auth.json holds a credential PiAbyss can log out of. */
  hasStoredCredential: boolean;
  enabled: boolean;
};

export type BuiltinProviderModelChoice = {
  id: string;
  name: string;
  /** Whether the model is offered in the chat model picker. */
  enabled: boolean;
};

export type BuiltinProviderModelsResult = {
  providerId: string;
  models: BuiltinProviderModelChoice[];
};

export type ProviderLoginPrompt = {
  promptId: string;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
};

export type ProviderLoginFlowEvent =
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "auth_url"; url: string; instructions?: string }
  | {
      kind: "device_code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number;
    }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; prompt: ProviderLoginPrompt }
  | { kind: "prompt_cancel"; promptId: string }
  | { kind: "done"; ok: boolean; message?: string };

export type ProviderConnectionCategory =
  | "ok"
  | "configuration"
  | "authentication"
  | "blocked"
  | "rate_limit"
  | "not_found"
  | "timeout"
  | "network"
  | "protocol"
  | "provider";

export type ProviderConnectionResult = {
  providerId: string;
  modelId: string;
  api: ProviderApi;
  ok: boolean;
  latencyMs: number;
  category: ProviderConnectionCategory;
  message: string;
  suggestion?: string;
};

/**
 * Per-station relay pricing snapshot (new-api / one-api style gateways).
 * All monetary values are in station balance units (USD-equivalent); CNY
 * display conversion is a pure frontend concern driven by the recharge ratio.
 */
export type RelayPricingGroup = {
  /** Group name as used in /api/pricing `group_ratio`, e.g. "Claude-kiro". */
  name: string;
  /** Multiplier applied on top of the base model ratio. */
  ratio: number;
  /** Human description from `usable_group`, when provided. */
  description?: string;
  /** True when this station's key routes through this group (auto groups). */
  isAuto?: boolean;
};

/** One expandable pricing row: model × group, final per-1M prices. */
export type RelayPricingRow = {
  stationId: string;
  modelId: string;
  modelName: string;
  vendor?: string;
  group: string;
  groupRatio: number;
  /** Token-priced rows carry per-1M USD prices; per-call rows carry callPrice. */
  inputPer1M: number | null;
  outputPer1M: number | null;
  cachePer1M: number | null;
  /** Per-call price (image/video/music); null for token-priced rows. */
  callPrice: number | null;
  /** Endpoint types, e.g. ["openai","anthropic"]. */
  endpoints: string[];
  /**
   * Per-model lookup key for groupsDetail second requests (raw value from
   * the modelDetailKey mapping; string or number). Never displayed.
   */
  detailKey?: string | number;
  /** Free-form tiered billing expression; surfaced as-is. */
  billingExpr?: string;
  /** True when the configured key's /v1/models list includes this model. */
  keyAvailable: boolean;
};

/** Balance snapshot for one station key. */
export type RelayBalance = {
  stationId: string;
  /** hard_limit_usd; a very large value is reported as unlimited. */
  hardLimitUsd: number;
  /** total_usage from /v1/dashboard/billing/usage. */
  totalUsageUsd: number;
  /** hardLimitUsd - totalUsageUsd, clamped at 0. */
  remainingUsd: number | null;
  unlimited: boolean;
  /**
   * Account currency of the balance values: "USD" (default) or "CNY".
   * Built-in new-api endpoints always report USD; presets may report the
   * station's native currency (e.g. DeepSeek CNY). Display-only — values
   * are shown with the currency's symbol, never converted.
   */
  currency?: "USD" | "CNY";
  fetchedAt: string;
  ok: boolean;
  /** Error message when ok is false. */
  error?: string;
};

/** One station entry inside the pricing table snapshot. */
export type RelayPricingStation = {
  stationId: string;
  /** models.json provider id this station is bound to, when configured. */
  providerId: string | null;
  baseUrl: string;
  name?: string;
  groups: RelayPricingGroup[];
  rows: RelayPricingRow[];
  /** Model ids returned by /v1/models for the configured key. */
  keyModels: string[];
  balance: RelayBalance | null;
  /** ISO timestamp of this station's last successful fetch. */
  fetchedAt: string | null;
  /** Present when the last fetch for this station failed. */
  error?: string;
};

/** Full pricing table snapshot persisted to piabyss/pricing.json. */
export type RelayPricingTable = {
  schemaVersion: 1;
  stations: RelayPricingStation[];
};

/** Recharge ratio for one station: CNY paid per 1 unit of balance. */
export type RelayRechargeRatio = {
  /** CNY actually paid. */
  cny: number;
  /** Balance units received. Defaults to 1 (1 CNY = 1 USD balance). */
  balance: number;
};

/**
 * Local canonical relay-station fields. Every provider's responses are mapped
 * onto these through a per-station mapping table, so adapting a new provider
 * never touches source code — only the mapping JSON.
 */
export type RelayFieldKey =
  /** Group multiplier map: groupName → multiplier on top of the base ratio. */
  | "groups"
  /** Optional groupName → description map. */
  | "groupDescriptions"
  /** groupName list whose group the configured key routes through. */
  | "autoGroups"
  /** Model list (array of objects) holding per-model pricing fields. */
  | "models"
  /** Model id field inside a model entry. */
  | "modelId"
  /** vendor name (string) or vendor id (number joined with vendors) per model. */
  | "modelVendor"
  /** Per-model token multiplier: input $ = BASE_PRICE × multiplier × groupRatio. */
  | "modelInputRatio"
  /** Output/input price multiplier. */
  | "modelCompletionRatio"
  /** Cached-input/input price multiplier. */
  | "modelCacheRatio"
  /** Per-call base price (quota_type ≠ 0 style billing). */
  | "modelCallPrice"
  /** Per-call marker field: nonzero/true means per-call billing. */
  | "modelPerCallFlag"
  /** Group names this model is offered in. */
  | "modelGroups"
  /**
   * Detail lookup key for per-model second-request endpoints (e.g. a numeric
   * pricing id used as {modelDetailKey} in groupsDetail.path). Never shown.
   */
  | "modelDetailKey"
  /** Supported endpoint type strings. */
  | "modelEndpoints"
  /** Key-visible model id list (the key's own /models view). */
  | "keyModels"
  /** Remaining balance in balance units (USD-equivalent). */
  | "balanceRemaining"
  /** Used amount; unit/scale chosen by the mapping's unit/scale options. */
  | "balanceUsed"
  /** Balance marker: value ≥ this threshold means unlimited. */
  | "balanceUnlimitedValue"
  /** Vendor registry: vendorId → vendorName (for numeric modelVendor). */
  | "vendors";

/** Item-level canonical fields (valid divideBy targets). */
export const RELAY_ITEM_FIELD_KEYS = [
  "modelId",
  "modelVendor",
  "modelInputRatio",
  "modelCompletionRatio",
  "modelCacheRatio",
  "modelCallPrice",
  "modelPerCallFlag",
  "modelGroups",
  "modelEndpoints",
  "modelDetailKey",
] as const;

/** How to interpret a mapped value. Defaults to "value" when omitted. */
export type RelayFieldReader = "value" | "entries" | "array";

/**
 * One mapping rule: where a canonical field lives in the provider's response
 * and (optionally) how to read/convert it. Paths are dot-delimited, `[]` at
 * the end marks "map over the enclosing array" (only meaningful inside
 * `models` / `vendors` item mappings or when the parent is an array).
 */
export type RelayFieldMapping = {
  /** Dot path from the endpoint payload root, e.g. "data[].model_ratio". */
  path: string;
  /** "entries" reads an object as name→value pairs; "array" reads a string[]. */
  reader?: RelayFieldReader;
  /** Item field name for "array"/entries-of-objects readers. */
  itemField?: string;
  /**
   * For entries reader over an object array: the field holding the entry's
   * value (e.g. "multiplier"). Without it the value is the record minus the
   * name field. Ignored by other readers.
   */
  itemValueField?: string;
  /** Multiply the raw value by this factor (default 1). */
  scale?: number;
  /**
   * Divide the raw value by another field's value from the same record
   * (items mode) — e.g. output price ÷ input price to express a relative
   * ratio. The named field must be an item-level canonical field key; its
   * own scale (if any) is applied before dividing.
   */
  divideBy?: (typeof RELAY_ITEM_FIELD_KEYS)[number];
  /**
   * Flag match (modelPerCallFlag): the field counts as flagged when the raw
   * value equals this string/number — e.g. path "billing_mode", equals
   * "flat" marks per-call rows on stations without a numeric marker.
   */
  equals?: string | number;
  /** Subtract from the raw value before scale (used by cent → unit). */
  offset?: number;
  /** Values at/above this threshold mean "unlimited balance". */
  unlimitedAbove?: number;
  /** Fixed fallback when the path is missing (field omitted otherwise). */
  fallback?: number | string;
};

/** Mapping rules for one upstream endpoint, keyed by canonical field. */
export type RelayEndpointMapping = {
  /** Endpoint path relative to the station base URL, e.g. "api/pricing". */
  path: string;
  /** Requires the API key (Authorization: Bearer). */
  auth: boolean;
  /** Per-field mapping rules for this endpoint. */
  fields: Partial<Record<RelayFieldKey, RelayFieldMapping>>;
  /**
   * Optional item-level mapping for list endpoints: when present, the field
   * paths are resolved relative to each item of the array at `path` instead
   * of a shared single payload (per-model/per-vendor fields).
   */
  fieldsApplyTo?: "root" | "items";
  /** For fieldsApplyTo "items": which canonical field carries the item list. */
  itemsField?: Extract<RelayFieldKey, "models" | "vendors" | "keyModels" | "autoGroups">;
  /**
   * For fieldsApplyTo "items": payload path of the record array (default: the
   * response root itself). Use "data" for {data:[...]}-style envelopes.
   */
  itemsPath?: string;
};

/**
 * Per-station field mapping table. `null` means "no custom mapping — use the
 * built-in new-api/one-api defaults". Written by the Agent via the robot-icon
 * handoff; users review it before it takes effect.
 */
export type RelayFieldMap = {
  schemaVersion: 1;
  /** Station/provider id this table applies to. */
  stationId: string;
  /**
   * When set, the mapping is shared by other providers pointing at the same
   * station. Match semantics: providers whose normalized baseUrl equals the
   * normalized value here always share; with shareScope "domain", providers
   * whose host ends with the same main domain (cf.x ≈ x.top) share too —
   * mirror entrances of one station. A provider's own explicit table wins.
   */
  shareByBaseUrl?: string;
  /** How shareByBaseUrl matches other providers (default "url"). */
  shareScope?: "url" | "domain";
  /** ISO timestamp of the last Agent/user edit. */
  updatedAt?: string;
  /** Set false to fall back to built-in defaults without deleting the table. */
  enabled?: boolean;
  /** Notes from the Agent (what it probed, what failed). */
  notes?: string;
  /** Endpoint mapping rules, keyed by canonical endpoint role. */
  endpoints: {
    /** Group ratios / model ratios / vendors (usually public). */
    pricing?: RelayEndpointMapping;
    /** Key-visible model list. */
    models?: RelayEndpointMapping;
    /** Remaining balance. */
    balance?: RelayEndpointMapping;
    /** Used amount (optional; often same endpoint as balance). */
    usage?: RelayEndpointMapping;
    /**
     * Per-model group detail endpoint (second request). The path may contain
     * `{fieldName}` placeholders resolved from each pricing model row's
     * mapped field value (e.g. "api/pricing/{modelId}"); one request is made
     * per distinct placeholder combination. Fields parse like any pricing
     * endpoint: groups / groupDescriptions / autoGroups. Group multipliers
     * found here are merged into the pricing table and each model row is
     * bound to its own groups.
     */
    groupsDetail?: RelayEndpointMapping;
  };
};

/** Result of provider.pricing.get / provider.pricing.fetch. */
export type RelayPricingResult = {
  table: RelayPricingTable;
  /** providerId → recharge ratio, from piabyss/pricing-config.json. */
  rechargeRatios: Record<string, RelayRechargeRatio>;
  /** True when the table came from disk cache (provider.pricing.get). */
  cached: boolean;
};

/** Result of provider.mapping.get: the station's mapping table (or null). */
export type RelayMappingResult = {
  stationId: string;
  /** Null when no custom mapping exists (built-in defaults are in effect). */
  mapping: RelayFieldMap | null;
};

/** Params for provider.mapping.set. */
export type RelayMappingSetParams = {
  stationId: string;
  /** Pass null to delete the custom mapping and return to defaults. */
  mapping: RelayFieldMap | null;
};

/** Absolute path of the mapping file the Agent should write, plus context. */
export type RelayMappingHandoffResult = {
  stationId: string;
  /** <agentDir>/piabyss/relay-pricing/mappings/<stationId>.json */
  mappingPath: string;
  /** The station base URL (baseUrl without trailing slash). */
  baseUrl: string;
  /** Whether an API key is configured for the provider. */
  hasApiKey: boolean;
  /** Where the Agent can read the API key (auth.json path). */
  authJsonPath: string;
  /** Current mapping (null → built-in defaults). */
  mapping: RelayFieldMap | null;
  /**
   * Same-station provider ids already sharing a mapping via shareByBaseUrl
   * (the own table counts). Empty when this provider is the first of its
   * station. Lets the Agent extend sharing instead of re-probing.
   */
  sharedWith: string[];
};

/** One entry of the provider.mapping.picker result: a merged station candidate. */
export type RelayMappingPickerEntry = {
  /** Canonical stationId whose mapping file backs this entry. */
  stationId: string;
  /** Display names of the merged providers (subset of provider names). */
  names: string[];
  /** The station base URL (without trailing slash). */
  baseUrl: string;
  /** Whether an API key is configured for the canonical provider. */
  hasApiKey: boolean;
  /** Whether an active field mapping already exists for this station. */
  hasMapping: boolean;
  /** Provider ids merged into this entry (same normalized URL or main domain). */
  providerIds: string[];
};

/** Result of provider.mapping.picker: merged station candidates for multi-select. */
export type RelayMappingPickerResult = {
  entries: RelayMappingPickerEntry[];
};

/** Params for provider.pricing.fetch. */
export type RelayPricingFetchParams = {
  /** Omit to refresh every configured station. */
  providerId?: string;
  /** Subset of provider ids to refresh (per-station refresh in the dialog). */
  providerIds?: string[];
};

/** Result of validating a Telegram bot token via `getMe`. */
export type TelegramValidateTokenResult = {
  /** Whether the getMe call succeeded with a bot-shaped result. */
  ok: boolean;
  /** Telegram bot user id. */
  botId?: number;
  /** Bot username without the leading @. */
  username?: string;
  /** Bot display name from getMe.first_name. */
  firstName?: string;
  /** Absolute path of the default Telegram workspace directory this host
   *  provisions for the gateway (`<agentDir>/workspace/telegram`). Always
   *  present when `ok` is true. */
  workspacePath?: string;
  /** Telegram error description when `ok` is false. */
  description?: string;
};

/** Telegram bot profile summary from the plugin-owned `<agentDir>/telegram.json`. */
export type TelegramProfileSummary = {
  /** Profile name (the plugin's canonical profile is `default`). */
  profile: string;
  /** Numeric Telegram bot user id. */
  botId?: number;
  /** Bot username without the leading @. */
  botUsername?: string;
  /** Bot display name (first_name). */
  botName?: string;
  /** Whether the profile carries a usable bot token. */
  configured: boolean;
};

/** One inbound update from the plugin's inbox journal, flattened for display. */
export type TelegramSessionSummary = {
  /** Absolute path of the session file (readable via `telegram.getSession`). */
  sessionPath: string;
  /** Session uuid parsed from the file, when present. */
  sessionId?: string;
  /** Session display name from session_info, when present. */
  name?: string;
  /** Workspace dir the session belongs to, when recorded. */
  cwd?: string;
  /** Unix ms of the file's last write. */
  updatedAt: number;
  /** Number of telegram-originated user messages found in the session. */
  telegramMessageCount: number;
  /** First telegram user message, truncated. */
  preview?: string;
};

/** Result of `telegram.listSessions`. */
export type TelegramSessionListResult = {
  sessions: TelegramSessionSummary[];
};

/** Result of `telegram.getSession`: the raw message records for read-only
 *  rendering (id/parentId/timestamp/message) plus a fresh summary. */
export type TelegramSessionDetail = {
  summary: TelegramSessionSummary;
  entries: SerializableSessionEntry[];
};

/** Plugin `assistant` config block (telegram.json, shared across profiles). */
export type TelegramAssistantConfig = {
  draftPreviews?: boolean;
  rendering?: "rich" | "html";
  proactivePush?: boolean;
  activity?: "quiet" | "thinking" | "tools" | "verbose";
  timeInjection?: "hidden" | "always" | "interval";
};

/** Plugin `voice` config block. */
export type TelegramVoiceConfig = {
  replyMode?: "manual" | "hidden" | "mirror" | "always";
};

/** Plugin `threads` config block. */
export type TelegramThreadsConfig = {
  automaticCleanup?: boolean;
};

/** Bound Telegram account (the first user who sent /start to the bot). */
export type TelegramBoundUser = {
  userId: number;
  username?: string;
  name?: string;
};

/** Bridge transport state from `telegram.status` (best-effort read of the
 *  plugin's owners.json — the 0.52.0+ `tmp/pi-telegram` layout first, then the
 *  legacy `tmp/telegram` file for older plugin releases). */
export type TelegramBridgeStatus = {
  /** Whether a Pi instance currently owns polling transport for a profile. */
  connected: boolean;
  /** The active profile name, when known. */
  profile?: string;
  /** Bot id of the owning profile, when known. */
  botId?: number;
  /** OS pid of the process that claimed transport ownership, when known. */
  ownerPid?: number;
};

/** Result of `telegram.getConfig` — never includes the raw bot token. */
export type TelegramConfigResult = {
  /** Default profile identity (configured status etc.). */
  default: TelegramProfileSummary | null;
  /** Absolute path of the telegram workspace dir, ensured to exist. */
  workspacePath: string;
  /** Masked bot token (`head***tail`) for display — never the raw token. */
  tokenMasked?: string;
  /** Bound owner account, or null when nobody has messaged the bot yet. */
  bound?: TelegramBoundUser | null;
  assistant?: TelegramAssistantConfig;
  voice?: TelegramVoiceConfig;
  threads?: TelegramThreadsConfig;
  /** Whether the @llblab/pi-telegram plugin is configured anywhere visible
   *  to this Host (project scope in the telegram workspace, or legacy user
   *  scope in the global agent settings). */
  pluginInstalled?: boolean;
  /** Where the plugin is currently configured: "project" = dedicated
   *  telegram workspace (the scope PiAbyss installs into); "user" = legacy
   *  global scope, reported so the desktop can offer migration; null when
   *  not installed. */
  pluginScope?: "user" | "project" | null;
};

export type SerializableAgentContent = {
  type: string;
  text?: string;
  [key: string]: JsonValue | undefined;
};

export type SerializableAgentToolResult = {
  content: SerializableAgentContent[];
  details: JsonValue;
  addedToolNames?: string[];
  terminate?: boolean;
};

export type SerializableToolInfo = {
  name: string;
  description?: string;
  parameters?: JsonValue;
  source?: string;
  /** Human-readable tool label declared by the registering extension
   *  (ToolDefinition.label); undefined for tools without a label. */
  label?: string;
  /** Registration path of the tool's defining extension (SourceInfo.path):
   *  an absolute extension file path for plugin tools, `<builtin:name>` for
   *  built-ins, `<sdk:name>` for host custom tools. Lets the UI attribute a
   *  tool to its plugin-library entry. */
  sourcePath?: string;
};

export type ToolSnapshot = {
  revision: number;
  workspaceId: string;
  sessionId: string;
  sessionRevision: number;
  tools: SerializableToolInfo[];
  active: string[];
};

export type SerializableAgentMessage = {
  role: string;
  content: SerializableAgentContent[] | string;
  usage?: SerializableUsage;
  /** Desktop-local marker for optimistic user bubbles; never sent on the wire. */
  _optimisticKey?: string;
  [key: string]: JsonValue | SerializableAgentContent[] | string | undefined;
};

/**
 * Plain-text projection produced by a registered Pi Extension message renderer.
 * Extension components and terminal control sequences never cross the Host boundary.
 */
export type ExtensionMessageRenderSnapshot = {
  version: 1;
  collapsed: string[];
  expanded: string[];
  /** Position in the current context-message projection, used before Desktop receives the entry ID. */
  messageIndex?: number;
};

export type SerializableUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type SessionContextUsage = {
  tokens: number | null;
  contextWindow: number;
  breakdown?: SessionContextBreakdown;
};

export type SessionContextBreakdown = {
  systemPrompt: number;
  toolDefinitions: number;
  userPrompts: number;
  assistantMessages: number;
  toolResults: number;
  summaries: number;
  other: number;
};

export type QueueSnapshot = {
  revision: number;
  steering: string[];
  followUp: string[];
};

export type SessionSnapshot = {
  sessionId: string;
  sessionPath?: string;
  name?: string;
  cwd: string;
  revision: number;
  isStreaming: boolean;
  isIdle: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  /** True when the most recent run settled because the user cancelled it
   *  (SDK `agent_settled.aborted`); cleared when the next run starts. */
  lastRunAborted?: boolean;
  model?: ModelSummary;
  thinkingLevel: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  pending: QueueSnapshot;
  contextUsage?: SessionContextUsage;
  messages: SerializableAgentMessage[];
  /**
   * The compaction-aware entry path for the current session leaf.
   *
   * This is optional so clients can continue to consume snapshots produced by
   * older hosts that only exposed the projected agent messages.
   */
  entries?: SerializableSessionEntry[];
  /** The leaf represented by `entries`, when the host exposes the entry path. */
  leafId?: string | null;
  /** Registered Extension renderer output, keyed by persisted custom-message entry ID. */
  extensionMessageRenders?: Record<string, ExtensionMessageRenderSnapshot>;
  tools: ToolSnapshot;
};

export type PackageCatalogItem = {
  /** npm package name, e.g. "@scope/pkg" or "pi-web-access". */
  name: string;
  description: string;
  author?: string;
  /** Resource kinds advertised by the catalog, e.g. ["extension", "skill"]. */
  types: string[];
  downloadsPerMonth?: number;
  /** Publication timestamp in epoch milliseconds. */
  publishedAt?: number;
  npmUrl?: string;
  githubUrl?: string;
  /** Catalog-provided text blob for client-side filtering. */
  searchText: string;
  /** Source string accepted by package.install, e.g. "npm:pi-web-access". */
  installSource: string;
  /** Detail page on the catalog site. */
  pageUrl: string;
};

export type PackageCatalog = {
  generatedAt: number;
  /** True when served from the in-memory cache instead of a fresh fetch. */
  fromCache: boolean;
  items: PackageCatalogItem[];
  /** 1-based page that produced `items`. */
  page: number;
  pageSize: number;
  /** Catalog-reported match count for the current query. */
  total: number;
  lastPage: number;
};

export type PackageRecord = {
  id: string;
  identity: string;
  source: string;
  kind: "npm" | "git" | "local";
  scope: "user" | "project";
  filtered: boolean;
  installed: boolean;
  installedPath?: string;
  displayName: string;
  description?: string;
  versionOrRef?: string;
  updateAvailable?: boolean;
  effective: boolean;
  shadowedByPackageId?: string;
  overridesPackageId?: string;
  projectOverride?: {
    source: string;
    overrideCount: number;
  };
  resourceCounts: {
    extensions: number;
    skills: number;
    prompts: number;
    themes: number;
    enabled: number;
    disabled: number;
  } | null;
  resourceCountsState: "resolvedEffective" | "unknownShadowed";
};

export type PackageDiagnostic = {
  severity: "info" | "warning" | "error";
  source?: string;
  message: string;
};

export type UserResourcePreference = "enabled" | "disabled";

export type ProjectResourcePreference = "inherit" | "enabled" | "disabled";

export type ResourceControl =
  | { kind: "preference"; scopes: Array<"user" | "project"> }
  | { kind: "owner-extension"; ownerResourceId: string }
  | { kind: "read-only"; reason: string };

export type ResourceRecord = {
  id: string;
  type: "extension" | "skill" | "prompt" | "theme";
  name: string;
  description?: string;
  path: string;
  relativePath?: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level" | "extension";
  source: string;
  packageId?: string;
  enabled: boolean;
  preferences: {
    user?: UserResourcePreference;
    project?: ProjectResourcePreference;
  };
  control: ResourceControl;
  manualOnly?: boolean;
  diagnostics: PackageDiagnostic[];
};

export type ResourcePreferenceUpdate =
  | {
      resourceId: string;
      targetScope: "user";
      preference: UserResourcePreference;
    }
  | {
      resourceId: string;
      targetScope: "project";
      preference: ProjectResourcePreference;
    };

export type PackageSnapshot = {
  revision: number;
  workspaceId: string;
  scope: "user" | "project" | "all";
  configured: PackageRecord[];
  resources: ResourceRecord[];
  updateCheck: {
    supported: boolean;
    checkedAt?: number;
  };
  diagnostics: PackageDiagnostic[];
  /** When true, agent.prompt is blocked until package.reloadResources succeeds. */
  resourceReloadRequired?: boolean;
  mutation?: {
    operationId: string;
    status: "running" | "partialFailure";
    reconcileRequired: boolean;
  };
};

export type RehydrateSnapshot = {
  /** Highest Host event sequence reflected by this composite snapshot. */
  watermark: number;
  host: HostStatusSnapshot;
  workspace: WorkspaceSnapshot | null;
  session: SessionSnapshot | null;
  tools: ToolSnapshot | null;
  packages: PackageSnapshot | null;
};

export type PackageMutationResult = {
  operationId: string;
  status: "committed" | "partialFailure" | "failed";
  packageSnapshot: PackageSnapshot;
  session?: SessionSnapshot;
  warnings: HostError[];
  reconcileRequired: boolean;
};

export type PackageUpdateSummary = {
  packageId: string;
  source: string;
  current?: string;
  available?: string;
};

/* ------------------------------------------------------------------ */
/* Plugin library (PiAbyss-curated registry, see my-pi-plugins repo)   */
/* ------------------------------------------------------------------ */

/** How a curated plugin is installed. "repo" entries live inside the
 *  registry's own git repository; "npm"/"git" are standalone pi packages. */
export type PluginLibraryInstallSource =
  | { type: "repo"; path: string }
  | { type: "npm"; source: string }
  | { type: "git"; source: string };

export type PluginLibraryConfigOption = { value: string; label: string };

/** One auto-generated configuration control. Values are persisted by PiAbyss
 *  and injected as environment variables (`env`) when the Host starts. */
export type PluginLibraryConfigItem = {
  key: string;
  type: "text" | "select";
  label: string;
  /** Environment variable name the value is injected under. */
  env: string;
  /** Text only: mask the input and never echo the value in plaintext UI. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  /** Default value; for selects this must be one of `options[].value`. */
  default?: string;
  /** Select only: allowed choices. May be omitted/empty when `optionsSource`
   *  tells the renderer to build the options dynamically at runtime. */
  options?: PluginLibraryConfigOption[];
  /** Select only: well-known dynamic option source. Known sources:
   *  - `pi:vision-models` — runtime vision-capable models (single select)
   *  - `pi:models` — every runtime-configured model (single select)
   *  - `pi:vision-models-fallback` — ordered vision fallback list
   *  - `pi:models-fallback` — ordered fallback list over all models
   *  Unknown sources must be ignored (static options/text input). */
  optionsSource?: string;
  description?: string;
};

export type PluginLibraryEntry = {
  id: string;
  name: string;
  description: string;
  /** Emoji character or an image path relative to the registry repository. */
  icon: string;
  version: string;
  author?: string;
  tags?: string[];
  install: PluginLibraryInstallSource;
  /** Preference scopes this plugin's enable switch may write.
   *  Omitted (or empty) means `["user", "project"]`: the card toggles the
   *  user-level preference globally and a workspace may override it.
   *  `["user"]` marks a plugin coupled to host-wide state: the workspace view
   *  shows a read-only "global only" badge instead of a switch, so a single
   *  workspace can neither enable nor disable it. */
  toggleScopes?: Array<"user" | "project">;
  /** Omitted (or empty) means the plugin needs no configuration. */
  config?: PluginLibraryConfigItem[];
};

export type PluginLibraryCatalog = {
  specVersion: number;
  /** Registry file URL the catalog was fetched from. */
  registryUrl: string;
  /** Pi install source of the registry repository; used for `repo` entries. */
  repoSource: string;
  fetchedAt: number;
  plugins: PluginLibraryEntry[];
  /** Human-readable notes for entries that failed validation and were dropped. */
  warnings: string[];
};

/** Toggle one curated plugin's extension pattern inside a package source
 *  entry (repo-type installs). */
export type PluginLibraryApplyParams = {
  /** Package source, e.g. "git:github.com/user/repo". */
  source: string;
  /** Extension glob relative to the package root, e.g. "packages/pi-web/extensions/**". */
  pattern: string;
  enabled: boolean;
};

/** Apply plugin config values to the running Host process environment.
 *  A null value unsets the variable. */
export type PluginLibraryEnvUpdate = {
  vars: Record<string, string | null>;
};

/** Resource kinds exposed by package and top-level resource listings. */
export type PackageResourceType = ResourceRecord["type"];

/** @deprecated Prefer PackageResourceType for package/resource APIs. */
export type ResourceType = PackageResourceType;

export type ExtensionPresentationAudience = "agent" | "user";
export type ExtensionPresentationKind = "activity" | "progress" | "decision" | "result" | "warning";
export type ExtensionPresentationStatus =
  "pending" | "running" | "resolved" | "cancelled" | "expired" | "failed";
export type ExtensionPresentationSeverity = "neutral" | "info" | "warning" | "danger";

/** Portable, declarative presentation hints for custom Extension messages. */
export type ExtensionPresentation = {
  version: 1;
  extensionId: string;
  audience: ExtensionPresentationAudience;
  kind: ExtensionPresentationKind;
  correlationId: string;
  sourceLabel?: string;
  status?: ExtensionPresentationStatus;
  severity?: ExtensionPresentationSeverity;
  groupKey?: string;
  title?: string;
  summary?: string;
  /** References a live Extension UI request; it is never executable by itself. */
  actionRequestId?: string;
  technicalDetails?: JsonValue;
};

export type ExtensionUiOption = {
  id: string;
  label: string;
  description?: string;
  /**
   * Rich markdown preview for this option (mockups, ASCII layouts, code).
   * Rendered in a monospace panel beside (wide) or below (narrow) the option
   * list. Plain monospace text — not interpreted as HTML.
   */
  preview?: string;
  destructive?: boolean;
};

export type ExtensionUiClosedReason = "aborted" | "timed-out" | "disposed" | "stale";

export type ExtensionUiClosed = {
  requestId: string;
  reason: ExtensionUiClosedReason;
};

export type ExtensionUiGroupStatus = "completed" | "failed" | "cancelled" | "stale";

export type ExtensionUiGroupClosed = {
  groupKey: string;
  status: ExtensionUiGroupStatus;
};

export type ExtensionUiSourceKind = "package" | "user" | "project" | "synthetic";

type ExtensionUiKnownOrigin = {
  extensionId: string;
  extensionDisplayName: string;
  sourceKind: ExtensionUiSourceKind;
};

export type ExtensionUiOrigin =
  | { invocationKind: "unknown" }
  | (ExtensionUiKnownOrigin & {
      invocationKind: "tool";
      toolName: string;
      toolCallId: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "command";
      commandName: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "shortcut";
      shortcut: string;
    })
  | (ExtensionUiKnownOrigin & {
      invocationKind: "event";
      eventType: string;
      toolName?: string;
      toolCallId?: string;
    })
  | (ExtensionUiKnownOrigin & { invocationKind: "background" });

export type ExtensionDecisionPresentation = "legacy-modal" | "auto" | "inline-first";

export type ExtensionUiPresentation = "inline" | "modal";
export type ExtensionUiRisk = "normal" | "high";

export type ExtensionUiRouteReason =
  | "stale-owner"
  | "explicit-modal"
  | "explicit-inline"
  | "high-risk"
  | "destructive-option"
  | "project-trust"
  | "session-lifecycle"
  | "active-tool"
  | "active-command"
  | "background-session"
  | "inline-unavailable"
  | "unknown-origin";

export type ExtensionUiRequest = {
  requestId: string;
  kind: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: ExtensionUiOption[];
  defaultValue?: string;
  timeoutMs?: number;
  sourceLabel?: string;
  correlationId?: string;
  presentationHint?: ExtensionUiPresentation;
  riskHint?: ExtensionUiRisk;
  presentation?: ExtensionUiPresentation;
  risk?: ExtensionUiRisk;
  routeReason?: ExtensionUiRouteReason;
  groupKey?: string;
  allowFreeform?: boolean;
  /**
   * 1-based ordinal of this question inside a multi-question questionnaire.
   * Lets the Desktop card show "Question 2 of 3" instead of relying on the
   * extension to bake the numbering into the title.
   */
  questionIndex?: number;
  /** Total questions in the same questionnaire. */
  questionCount?: number;
  /**
   * Short chip label for this question (the extension's `header`). Carried
   * separately so the card can render it as a chip rather than receiving it
   * pre-concatenated into `title`.
   */
  questionHeader?: string;
  /**
   * `kind: "input"` requests that carry `options` may set this to ask the
   * Desktop for a checkbox list instead of a free-text field. The Desktop
   * returns the chosen 1-based positions joined with commas (e.g. `"1,3"`),
   * which is the same shape the extension's numeric multi-select parser expects.
   */
  multiSelect?: boolean;
  origin?: ExtensionUiOrigin;
};

export type SerializableSessionEntry = {
  id: string;
  type: string;
  [key: string]: JsonValue | undefined;
};

export type SerializableSessionTreeNode = {
  entry: SerializableSessionEntry;
  children: SerializableSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

export type SessionTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type SessionStatsTiming = {
  /** Summed request wall time over assistant steps, derived from persisted
   * entry timestamps (trigger entry → assistant message completion). */
  llmMs: number;
  /** Summed tool wall time, derived from persisted entry timestamps
   * (assistant message completion → tool result). */
  toolMs: number;
  /** First-token latency (LLM request start → first content delta) sum and
   * message count from persisted `piabyss.timing` custom entries. Absent
   * when no timing has been persisted yet. */
  ttftMs?: number;
  ttftSteps?: number;
  /** Decode wall time and output tokens over the same persisted messages.
   * Absent when no measured message reported output tokens. */
  decodeMs?: number;
  decodeTokens?: number;
};

export type SessionStatsSnapshot = {
  messageCount: number;
  toolCallCount?: number;
  tokenUsage?: JsonValue;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolResultCount?: number;
  /** Aggregated over ALL session entries, including compacted-away history. */
  tokens?: SessionTokenTotals;
  /** Approximate wall-clock timings over ALL session entries, including
   * compacted-away history. Absent from hosts that do not derive it. */
  timing?: SessionStatsTiming;
  cost?: number;
  sessionFile?: string;
};

export type UsageRange = "today" | "7d" | "30d" | "all";

export type SessionUsageModelItem = {
  provider: string;
  providerName?: string;
  modelId: string;
  sessionCount: number;
  usage: SerializableUsage;
};

export type SessionUsageReportItem = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
  usage: SerializableUsage;
  models?: SessionUsageModelItem[];
};

export type SessionUsageReport = {
  workspaceId: string;
  generatedAt: number;
  totals: {
    sessionCount: number;
    messageCount: number;
    usage: SerializableUsage;
  };
  models?: SessionUsageModelItem[];
  sessions: SessionUsageReportItem[];
};

export type SessionSearchMatch = {
  role: "user" | "assistant";
  /** Short excerpt around the first matched term, whitespace-collapsed. */
  snippet: string;
};

export type SessionSearchResultItem = {
  sessionId: string;
  sessionPath: string;
  name?: string;
  /** Workspace path recorded in the session header. */
  cwd: string;
  archived: boolean;
  updatedAt: number;
  /** Total matching message blocks in the session (may exceed matches.length). */
  matchCount: number;
  /** Capped list of match excerpts. */
  matches: SessionSearchMatch[];
  /** True when the session name itself matched the query. */
  nameMatched: boolean;
};

export type SessionSearchReport = {
  generatedAt: number;
  query: string;
  /** Total session files scanned across all workspaces. */
  scannedCount: number;
  /** True when more sessions matched than the returned item cap. */
  truncated: boolean;
  items: SessionSearchResultItem[];
};

export type CommandSummary = {
  /** Text after the leading slash, e.g. "plan" or "skill:review" */
  invocation: string;
  description: string;
  argumentHint?: string;
  kind: "template" | "command" | "skill";
};

export type SerializableImage = {
  mediaType: string;
  data: string;
};

export type AttachmentStatus = "copying" | "parsing" | "ready" | "needs_ocr" | "failed";

export type AttachmentMediaType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "text/plain";

export type AttachmentUnit = "page" | "chunk";

export type AttachmentSnapshot = {
  id: string;
  name: string;
  mediaType: AttachmentMediaType;
  sizeBytes: number;
  status: AttachmentStatus;
  unit?: AttachmentUnit;
  unitCount?: number;
  processedUnits?: number;
  error?: string;
  /** Absolute path of the original source file (path attachments only). */
  sourcePath?: string;
};

export type SerializableCompactionResult = {
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  [key: string]: JsonValue | undefined;
};

/** Compact, replayable projection of the SDK's AssistantMessageEvent. */
export type SerializableAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; name: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: JsonValue }
  | { type: "done"; reason: string }
  | { type: "error"; reason: string; errorMessage?: string };

export type SerializableAgentSessionEvent = {
  type: string;
  [key: string]: JsonValue | undefined;
};

export const DESKTOP_THEMES = ["light", "dark", "system"] as const;
export type DesktopTheme = (typeof DESKTOP_THEMES)[number];

export const DESKTOP_THEME_FAMILIES = ["piabyss", "vercel", "apple", "transparent"] as const;
export type DesktopThemeFamily = (typeof DESKTOP_THEME_FAMILIES)[number];

export const DESKTOP_LANGUAGES = ["system", "en", "zh"] as const;
export type DesktopLanguage = (typeof DESKTOP_LANGUAGES)[number];

export const DESKTOP_INTERFACE_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type DesktopInterfaceDensity = (typeof DESKTOP_INTERFACE_DENSITIES)[number];

export const DESKTOP_INTERFACE_FONTS = ["default", "system"] as const;
export type DesktopInterfaceFont = (typeof DESKTOP_INTERFACE_FONTS)[number];

export const BUSY_SEND_BEHAVIORS = ["followUp", "steer"] as const;
export type BusySendBehavior = (typeof BUSY_SEND_BEHAVIORS)[number];

export const TERMINAL_PROFILE_IDS = [
  "auto",
  "pwsh",
  "windows-powershell",
  "cmd",
  "git-bash",
  "wsl-default",
  "zsh",
  "bash",
  "fish",
  "sh",
] as const;
export type TerminalProfileId = (typeof TERMINAL_PROFILE_IDS)[number];

export type DesktopSettings = {
  theme: DesktopTheme;
  /** Visual theme family; absent values use the original PiAbyss palette. */
  themeFamily?: DesktopThemeFamily;
  defaultWorkspace?: string;
  /** Launch PiAbyss with Windows at login and keep it hidden in the system tray. */
  autoStartOnBoot?: boolean;
  /** Deliver OS-level notifications for background completions, failures,
   *  input requests and Host fatals while the window is not focused. */
  systemNotificationsEnabled?: boolean;
  lastWorkspace?: string;
  lastSessionPath?: string;
  agentDir?: string;
  autoRestartHostOnce: boolean;
  /** How Composer sends messages while the Session is already running. */
  busySendBehavior?: BusySendBehavior;
  extensionDecisionPresentation: ExtensionDecisionPresentation;
  terminalProfile: TerminalProfileId;
  /** UI language; "system" (or absent) follows the OS locale. */
  language?: DesktopLanguage;
  /** Plugin-library configuration: plugin id → env var name → value.
   *  Injected into the Host process environment when it starts. */
  pluginEnv?: Record<string, Record<string, string>>;
  /** Spacing density for frequently used interface controls and rows. */
  interfaceDensity?: DesktopInterfaceDensity;
  /** Sans font family used across the interface; absent values use the theme default. */
  interfaceFont?: DesktopInterfaceFont;
  /** Accent (highlight) color as a normalized `#rrggbb` hex string used for
   *  buttons, links and selection states; absent values follow the theme
   *  family's own accent. */
  accentColor?: string;
  /** Minimum width of the aligned conversation surfaces, in CSS pixels. */
  conversationMinWidth?: number;
  /** Maximum width of the aligned conversation surfaces, in CSS pixels. */
  conversationMaxWidth?: number;
  /** Base font size for conversation content, in CSS pixels. */
  conversationFontSize?: number;
  /** Line-height multiplier for conversation content, bounded to a readable range. */
  conversationLineHeight?: number;
  /** Font size for inline and fenced conversation code, in CSS pixels. */
  codeFontSize?: number;
  /** Persistent list of workspace folders shown in the sidebar. */
  knownWorkspaces?: string[];
  /** Per-command shortcut overrides. null explicitly disables a command binding. */
  shortcutOverrides?: Record<string, string | null>;
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;

/* ── Schedule（pi-schedule 插件控制面）────────────────────────── */

export type SchedulePermission = "read_only" | "write" | "full";
export type ScheduleMissedWindow = "catch_up_one" | "skip";
export type ScheduleRunStatus = "running" | "ok" | "error" | "timeout" | "aborted";
export type ScheduleRunTrigger = "manual" | "once" | "interval" | "cron" | "reply";
export type ScheduleTermination = "once" | "maxRuns" | "missed";
/** 按计划推送配置：none 关闭；system 系统通知；tg 为 Telegram 通道预留。 */
export type ScheduleNotifyMode = "none" | "system" | "tg";

/** 触发方式：manual = 仅手动，不进自动计划。 */
export type ScheduleTrigger =
  | { type: "manual" }
  | { type: "once"; at: string }
  | { type: "interval"; every: string }
  | { type: "cron"; cron: string; timezone?: string };

/** 模型引用；null = 用宿主默认模型。 */
export type ScheduleModelRef = {
  provider: string;
  id: string;
  thinkingLevel?: string;
};

/** 任务定义（对应插件 jobs.json 里的一条记录）。 */
export type ScheduleJob = {
  id: string;
  name: string;
  /** 任务内容（执行会话的任务书）；命令型任务为 ""。 */
  prompt: string;
  /** 命令型任务：非空时触发后直接执行 shell 命令，与 prompt 互斥。 */
  command: string | null;
  /** 工作区绝对路径（执行会话的 cwd）。 */
  cwd: string;
  enabled: boolean;
  permission: SchedulePermission;
  model: ScheduleModelRef | null;
  trigger: ScheduleTrigger;
  missedWindow: ScheduleMissedWindow;
  timeoutMs: number;
  maxRuns: number | null;
  loadExtensions: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: ScheduleRunStatus | null;
  runCount: number;
  terminated: ScheduleTermination | null;
  /** Older plugin versions don't persist this field — treat as "none". */
  notify?: ScheduleNotifyMode;
};

/** 创建任务的请求体。 */
export type ScheduleJobInput = {
  name: string;
  prompt: string;
  command?: string | null;
  cwd: string;
  trigger: ScheduleTrigger;
  permission?: SchedulePermission;
  model?: ScheduleModelRef | null;
  missedWindow?: ScheduleMissedWindow;
  timeoutMs?: number;
  maxRuns?: number | null;
  loadExtensions?: boolean;
  tags?: string[];
  enabled?: boolean;
  notify?: ScheduleNotifyMode;
};

/** 修改任务：id 必带，其余字段可选（部分更新）。 */
export type ScheduleJobPatch = Partial<ScheduleJobInput> & { id: string };

export type ScheduleUsageSummary = {
  input: number;
  output: number;
  total: number;
  cost: number;
};

/** 执行记录的精简视图（对应插件 RunSummary）。 */
export type ScheduleRunSummary = {
  runId: string;
  jobId: string;
  jobName: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  model: ScheduleModelRef | null;
  permission: SchedulePermission;
  /**
   * 本次实际生效的工具白名单（full 档为 `["*"]`，命令型任务为 `[]`）。
   * 无人值守执行的底牌：面板要能回答「这一轮到底给了哪些工具」，用户才看得出
   * 「任务书要用 OCR，可执行会话里根本没有那个工具」。
   */
  tools: string[];
  /** 执行会话文件；命令型任务与尚未建会话的早期 running 为 null。 */
  sessionPath: string | null;
  /** 本次执行的命令（仅命令型任务非空）。 */
  command: string | null;
  forkOf: string | null;
  summary: string;
  error: string | null;
  usage: ScheduleUsageSummary | null;
  toolCalls: number;
};

/**
 * schedule.runMessages 结果：一次执行的过程。
 *
 * 读法是 Host 直接读 run 的会话 jsonl（`sessionPath`），而不是插件那个拍平的
 * `/runs/:id/transcript`——后者丢掉 thinking、连 `toolResult` 都不返回，撑不出
 * 「像普通会话那样折叠展开」。消息形状与智能创建会话同源，前端走同一套
 * `buildTranscriptRows` 投影。命令型任务没有会话：`messages` 为空，输出看 run 的
 * `summary`/`outputText`。
 */
export type ScheduleRunMessages = {
  found: boolean;
  sessionPath: string | null;
  /** 这一轮是否还在执行中（决定面板显示「停止」还是「已结束」）。 */
  running: boolean;
  messages: ScheduleAgentMessage[];
};

/** 插件通知队列条目。 */
export type ScheduleNotification = {
  at: string;
  jobId: string;
  jobName: string;
  runId: string;
  status: ScheduleRunStatus;
  level: "info" | "error";
  title: string;
  message: string;
};

/** `GET /api/health` 的响应。 */
export type ScheduleHealth = {
  ok: boolean;
  root: string;
  port: number | null;
  activeJobs: string[];
  tickMs: number;
  maxConcurrent: number;
};

/** 智能创建对话的消息（精简转录）。
 *
 * The message keeps the raw content blocks alongside the flattened `text`:
 * the page feeds `content` through the same transcript projection as a normal
 * workspace session (`buildTranscriptRows`), so reasoning and tool calls fold
 * exactly like the conversation area instead of being flattened to plain text.
 * `text`/`reasoning` stay for the plan-block extraction and the backlog title. */
export type ScheduleAgentMessage = {
  role: string;
  text: string;
  reasoning?: string;
  /** Raw content blocks (text/thinking/toolCall/image) of this message. */
  content?: SerializableAgentContent[];
  /** `toolResult` linkage, mirrored from the session message. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

/** schedule.status 结果：插件未启动时 available=false（不作为协议错误）。 */
export type ScheduleStatus = {
  available: boolean;
  health: ScheduleHealth | null;
  error: string | null;
};

/* ── 小精灵（pixie）───────────────────────────────────────────────
 * 小精灵 = 真实文件夹工作区（<agentDir>/workspace/pixie）+ 标准普通会话 +
 * 会话段时间线（timeline.json 只存指针，段渲染读标准会话 JSONL）。
 * 委派：pixie_dispatch 工具把任务派给工作区正式会话；
 * 回调三类：done / error / ask —— pixie_report、回合结束自动兜底、pixie_ask。
 * v4.1：排队串行（queued 不发信封由引擎持有）、插话（interject 附属于进行中
 * 委派，非新任务）、叫停（stopped/cancelled）、进度检查点（progress 非终态）、
 * 失联主动提醒（staleWarning）、批次聚合（batchId）、重试链（retryOf）。
 */

/**
 * 一条委派记录的生命周期状态。
 * - dispatched：已注入目标会话运行中
 * - queued：排队中（目标会话有活跃委派，引擎持队列，未发信封）
 * - paused：进度检查点 wait 模式（汇报后暂停，插入新指令即恢复）
 * - awaiting_user：pixie_ask 等待用户答复
 * - reported / failed：终态（完成 / 出错）
 * - stopped：被叫停（运行中会话被 abort）
 * - cancelled：排队中被取消（纯摘队列，未碰过会话）
 */
export type PixieDispatchStatus =
  | "dispatched"
  | "queued"
  | "paused"
  | "awaiting_user"
  | "reported"
  | "failed"
  | "stopped"
  | "cancelled";

/** 委派回调种类：完成 / 报错 / 询问用户 / 进度（非终态）/ 叫停知情。 */
export type PixieDispatchKind = "done" | "error" | "ask" | "progress" | "stopped";

/** 被委派会话的存活状态（错误推送携带，驱动失败决策流）。 */
export type PixieSessionAlive = "alive" | "dead" | "stopped";

/** pixie.stopDispatch 的动作结果。 */
export type PixieStopAction = "aborted" | "already-stopped" | "cancelled";

/** 标准会话存储中一个历史会话的摘要（pixie.listSessions 返回）。 */
export type PixieWorkspaceSessionSummary = {
  id: string;
  /** 会话 JSONL 文件路径。 */
  path: string;
  createdAt: number;
  lastActiveAt: number;
  /** 消息条数（粗略规模）。 */
  turns: number;
  /** 最后一条 user/assistant 消息摘要（≤120 字）。 */
  summary: string;
};

/** 小精灵会话的流式消息，形状与 schedule agent 的投影一致。 */
export type PixieAgentMessage = {
  role: string;
  text: string;
  reasoning?: string;
  content?: unknown[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

/** 一条委派记录（注册表 + 前端展示共用）。 */
export type PixieDispatchRecord = {
  id: string;
  status: PixieDispatchStatus;
  /** 回调种类：终态落定 done/error/stopped；进行中为 ask（等答复）/ progress（检查点汇报后回到运行）。 */
  kind: PixieDispatchKind | null;
  /** 目标工作区 cwd（Host 规范化后）。 */
  cwd: string;
  /** 目标会话 id（存在时）。 */
  sessionId: string | null;
  /** 目标会话文件路径（新建会话后回填）。 */
  sessionPath: string | null;
  /** 委派给目标会话的任务说明（用户可读）。 */
  task: string;
  /** pixie_report / 自动兜底回传的结果摘要（reported 后有值）。 */
  report: string | null;
  /** ask 回调等待用户答复的问题（awaiting_user 期间有值）。 */
  question: string | null;
  /** ask 回调附带的可选项。 */
  options: string[];
  createdAt: number;
  /** 排队中记录：出队并注入会话的时间（未出队为 null）。 */
  startedAt: number | null;
  reportedAt: number | null;
  /** 最后活跃时间（信封注入 / 回调 / 回合事件时更新；查岗展示用）。 */
  lastActiveAt: number | null;
  /** 回调超时标记：超过阈值未回调时置 true（默认 30 分钟，可配置）。 */
  stale: boolean;
  /** 失联提醒是否已推送（每条仅提醒一次）。 */
  staleNotified: boolean;
  /** 批次聚合标记（一次并行派发多任务时同批共享；无批次为 null）。 */
  batchId: string | null;
  /** 连续失败计数（resume / redispatch 成功启动后保留并 +1；升级阈值判定用）。 */
  failCount: number;
  /** 最近一次进度摘要（progress 回调或查岗推断更新）。 */
  progressSummary: string | null;
  /** 回调携带的产物/变更文件清单（progress/done 回调可带；无则 null）。 */
  files: string[] | null;
  /** 重派链来源：本记录由哪条失败记录重派而来（redispatch 时回填）。 */
  retryOf: string | null;
  /**
   * 当前生效的委派模型（"provider/id"）：dispatch/interject 显式指定时记录；
   * null = 跟随目标会话自身模型（未经授权小精灵不得更换）。
   */
  model: string | null;
  /** 当前生效的推理深度（off|minimal|low|medium|high|xhigh|max）；null = 会话默认。 */
  thinkingLevel: string | null;
  /**
   * 发起委派时小精灵所在的会话段 id：委派面板按当前段过滤的归属键。
   * 活跃委派跨段仍可见（回调注入的是当前段）；null = 旧版记录无归属，
   * 面板语义下全段可见。
   */
  originSessionId: string | null;
  /**
   * 小精灵给这条任务起的短名（≤20 字，长度由 Host 统一裁）。
   * null = 旧版插件未传 → 展示层用 task 前缀兜底。与会话名是两个语义：
   * 复用既有会话派新任务时只动这里，绝不影响会话名。
   */
  taskName?: string | null;
  /**
   * 本次委派所属会话的显示名（同样 ≤20 字口径）：
   * - 新建会话 = 本次采用的名字（未传 sessionName 时 Host 用 task 前缀兜底）；
   * - 复用既有会话 = 会话当时的现有名，取不到为 null。
   * 两种情况都不会改写会话名——复用一律沿用原名。
   */
  sessionName?: string | null;
  /**
   * 已退役：面板跳转改为按会话打开后，锚点抓取整体下线，这两个字段不再有人
   * 写。留在类型里是为了旧 dispatches.json 能原样读回，新记录恒为 null。
   */
  dispatchMessageId?: string | null;
  reportMessageId?: string | null;
};

/** 任务对外收敛的四态；详细生命周期仍留在 PixieDispatchStatus。 */
export type PixieTaskStatus = "queued" | "running" | "done" | "failed";

/** 任务层：只显示短名 + 状态，不显示提示词全文与结束内容。 */
export type PixieTaskTreeTask = {
  dispatchId: string;
  /** 短名（taskName，未传时 Host 用 task 前缀裁切兜底）。 */
  label: string;
  status: PixieTaskStatus;
  /** 原始生命周期状态（面板据此细分「等你回复」）。 */
  statusDetail: PixieDispatchStatus;
  kind: PixieDispatchKind | null;
  /** ask 的问题：面板不渲染正文，但记录里得留着它。 */
  question: string | null;
  options: string[];
  failCount: number;
  stale: boolean;
  createdAt: number;
  lastActiveAt: number | null;
};

/**
 * 会话落点的存活状态。面板上的行来自委派记录，而记录不会随会话删除消失，
 * 所以「这一行的会话还在不在」得由 Host 替前端看一眼磁盘——前端拿到这个状态
 * 后可以在跳转**之前**就把已删除的判掉（就地提示），而不是先切工作区、
 * 再告诉用户打不开。
 */
export type PixieSessionLiveness =
  /** 会话文件还在活动目录里，跳转能打开。 */
  | "active"
  /** 已被归档：文件在归档目录里，先在会话列表恢复才打得开。 */
  | "archived"
  /** 两处都找不到——多半是被删了。 */
  | "missing"
  /** 记录里没有落点路径（受理前就失败的记录），无从判定。 */
  | "unknown";

/** 会话层：会话名优先（sessionName / 复用会话的现有名），兜底用该会话最早任务。 */
export type PixieTaskTreeSession = {
  sessionId: string;
  label: string;
  /** 记录上的会话文件路径（跳转直接用它，不必回查 session.list）；未落点时为 null。 */
  sessionPath: string | null;
  /** 这个落点还在不在（见 PixieSessionLiveness）。 */
  liveness: PixieSessionLiveness;
  tasks: PixieTaskTreeTask[];
};

/** 工作区层：workspaceLabel 由 cwd 推导（与前端侧边栏同口径的目录名）。 */
export type PixieTaskTreeWorkspace = {
  cwd: string;
  workspaceLabel: string;
  sessions: PixieTaskTreeSession[];
};

/** pixie.usage 结果：留存判定埋点（按天计数）。 */
export type PixieUsageStats = {
  /** 按天（本地日期 YYYY-MM-DD）计数，仅保留最近 30 天。 */
  days: Record<string, { interactions: number; dispatches: number }>;
};

/** 小精灵当前生效的模型选择。 */
export type PixieModelSelection = { provider: string; id: string };

/** 可选模型项（与普通会话 model.list 的选项同源）。 */
export type PixieModelOption = {
  provider: string;
  providerName?: string;
  id: string;
  label: string;
};

/** 备忘录状态：待处理 / 进行中 / 已完成。 */
export type MemoNoteStatus = "open" | "in_progress" | "done";

/** 备忘录周期频率。 */
export type MemoRecurrenceFrequency = "daily" | "weekly" | "monthly";

/**
 * 备忘录周期规则（结构化，非 cron；权威实现见 pi-host/src/recurrence.ts）。
 * 时刻计算一律在规则声明的 IANA 时区内进行，不依赖设备本地时区。
 */
export type MemoRecurrence = {
  frequency: MemoRecurrenceFrequency;
  /** 每 N 天/周/月发生一次；1 = 每天/每周/每月（上限 365）。 */
  interval: number;
  /** weekly 必填：ISO 星期（1=周一 … 7=周日，去重升序）；其余频率恒为 []。 */
  weekdays: number[];
  /** monthly 必填：每月几号（1..31）；其余频率恒为 null。 */
  monthDay: number | null;
  /** 发生当天的时刻（24 小时制 "HH:mm"）。 */
  time: string;
  /** IANA 时区（如 "Asia/Shanghai"）。 */
  tz: string;
  /** 周期终点（epoch ms，含端点）；null = 无限期。 */
  until: number | null;
  /** interval 对齐锚点（epoch ms）；null 时以记录 createdAt 为锚。 */
  startDate: number | null;
};

/** 备忘录记录的图片引用（图片文件由 Host 存储在备忘录目录下）。 */
export type MemoImage = {
  id: string;
  /** 原始文件名（仅用于展示与扩展名推断）。 */
  fileName: string;
  mediaType: string;
  bytes: number;
};

/** Agent 处理备忘录后的结果总结（由 piabyss_memo 工具写入，覆盖式更新）。 */
export type MemoAgentResult = {
  /** 结果总结（Markdown）。 */
  resultMd: string;
  /** 提交总结时所在的会话（用于「继续讨论」跳转）。 */
  sessionId: string;
  /** 会话文件路径（跨工作区跳转用；可能为 null）。 */
  sessionPath: string | null;
  /** 提交时的会话标题（展示用）。 */
  sessionTitle: string | null;
  /** 提交时的工作区 cwd（跨工作区跳转用）。 */
  sessionCwd: string | null;
  /** 提交时间。 */
  at: number;
};

/** 备忘录记录（全局共享，不随工作区隔离；workspaceHint 仅作关联标签）。 */
export type MemoNote = {
  id: string;
  title: string;
  contentMd: string;
  status: MemoNoteStatus;
  tags: string[];
  /** 可空的工作区关联标签（目录名或路径），仅用于过滤与提示。 */
  workspaceHint: string | null;
  images: MemoImage[];
  createdAt: number;
  updatedAt: number;
  /** 最近一次执行所绑定的会话 ID；没有执行会话时为 null。可选以兼容旧版内存快照。 */
  sessionId?: string | null;
  /** 状态变为 done 的时间；非 done 恒为 null。 */
  completedAt: number | null;
  /** 最近一次 Agent 处理的结果总结；手动标记完成不产生总结。重新处理会覆盖旧总结。 */
  result: MemoAgentResult | null;
  /**
   * 删除墓碑（多设备同步用）：删除时置为时间戳并保留记录体，同步引擎据此
   * 把删除传播到其他设备（编辑时间晚于墓碑可复活）；超过 TTL 后物理清除。
   */
  deletedAt: number | null;
  /** 一次性截止时刻（epoch ms）；周期记录不使用。null = 无截止。 */
  dueAt: number | null;
  /** 周期规则；null = 非周期记录。清除（置 null）= 停用周期。 */
  recurrence: MemoRecurrence | null;
  /** 周期记录当前轮次应处理时刻（epoch ms）；非周期记录恒为 null。 */
  nextDueAt: number | null;
  /** 周期记录最近一轮完成时刻（epoch ms）；从未完成过为 null。 */
  lastDoneAt: number | null;
};

/** 备忘录「新建」草稿（仅本机持久化，不参与云同步；不含图片附件）。 */
export type MemoDraft = {
  contentMd: string;
  workspaceHint: string | null;
  updatedAt: number;
};

/** memo.setDraft 的输入：草稿不参与云同步，字段与 MemoDraft 对应（缺 updatedAt）。 */
export type MemoDraftInput = {
  contentMd: string;
  workspaceHint?: string | null;
};

/**
 * 备忘录云同步状态（引擎由 piabyss-memo 插件自持，Host 只代理）。
 * R2 密钥不进协议层：只回报非敏感的 accountId / 桶名与「是否已配置齐」。
 */
export type MemoSyncSettings = {
  /** R2 账户 ID（非敏感，展示用；未配置为空串）。 */
  accountId: string;
  /** R2 桶名（非敏感，展示用；未配置为空串）。 */
  bucket: string;
  /** 四项 R2 连接信息（accountId/accessKeyId/secretAccessKey/bucket）是否齐备。 */
  configured: boolean;
  /** 备忘录变更后自动同步（在设置的插件配置里管理）。 */
  autoSync: boolean;
  /** 最近一次同步（含手动与自动）时间；从未同步为 null。 */
  lastSyncAt: number | null;
  lastSyncOk: boolean | null;
  lastSyncError: string | null;
};

/** 上传图片的输入载荷：base64 不含 `data:` 前缀。 */
export type MemoImageInput = {
  fileName: string;
  mediaType: string;
  dataBase64: string;
};

/** 后台 shell 任务（pi shelljob 工具）的生命周期状态。 */
export type ShellJobStatus = "running" | "completed" | "failed" | "killed" | "unknown";

/** 单个后台 shell 任务的摘要（不含输出内容）。 */
export type ShellJobSummary = {
  id: string;
  command: string;
  cwd: string;
  /** 提交该任务的主会话 id（用于跳转定位）。 */
  sessionId: string;
  createdAt: number;
  status: ShellJobStatus;
  title?: string;
  pid?: number;
  startedAt?: number;
  finishedAt?: number;
};

/** 全量后台 shell 任务快照（list 结果与 changed 事件共用）。 */
export type ShellJobsSnapshot = {
  jobs: ShellJobSummary[];
};

/** 后台任务输出尾部（shelljobs.output 结果）。 */
export type ShellJobOutput = {
  /** 最后 N 行输出，每行已截断到安全长度。 */
  lines: string[];
  /** true 表示只返回了尾部（输出超过读取上限或行数上限）。 */
  truncated: boolean;
};
