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
 *  plugin's `tmp/telegram/owners.json`). */
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

export type SessionStatsSnapshot = {
  messageCount: number;
  toolCallCount?: number;
  tokenUsage?: JsonValue;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolResultCount?: number;
  /** Aggregated over ALL session entries, including compacted-away history. */
  tokens?: SessionTokenTotals;
  cost?: number;
  sessionFile?: string;
};

export type UsageRange = "today" | "7d" | "all";

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
  restoreLastSession: boolean;
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
  /** Minimum width of the aligned conversation surfaces, in CSS pixels. */
  conversationMinWidth?: number;
  /** Maximum width of the aligned conversation surfaces, in CSS pixels. */
  conversationMaxWidth?: number;
  /** Base font size for conversation content, in CSS pixels. */
  conversationFontSize?: number;
  /** Font size for inline and fenced conversation code, in CSS pixels. */
  codeFontSize?: number;
  /** Maximum number of recently active or idle Session runtimes to retain. */
  idleSessionCacheLimit?: number;
  /** Minutes an idle cached Session may remain untouched before disposal. */
  idleSessionTimeoutMinutes?: number;
  /** Persistent list of workspace folders shown in the sidebar. */
  knownWorkspaces?: string[];
  /** Per-command shortcut overrides. null explicitly disables a command binding. */
  shortcutOverrides?: Record<string, string | null>;
};

export type DesktopSettingsPatch = Partial<DesktopSettings>;
