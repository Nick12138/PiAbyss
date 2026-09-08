import { createHostError, type GitStatusSnapshot, type HostError } from "@piabyss/protocol";
import {
  completeSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai/compat";
import { GitService, GitServiceError } from "./git-service.js";
import { withRegisteredGraphMutation } from "./registered-graph-mutation.js";
import type { MethodHandler } from "./server.js";
import type { WorkspaceGraphFactory } from "./workspace-graph-factory.js";

function hostError(error: unknown): HostError {
  if (error instanceof GitServiceError) {
    return createHostError(error.code, error.message, { retryable: error.retryable });
  }
  return createHostError(
    "GIT_OPERATION_FAILED",
    error instanceof Error ? error.message : String(error),
  );
}

function workspace(factory: WorkspaceGraphFactory): string | null {
  return factory.getGraph()?.canonicalCwd ?? null;
}

/**
 * Output-token budget for the commit-message call. Reasoning models spend a
 * large share of the budget on hidden thinking; 300 tokens were frequently
 * exhausted before any visible answer, producing an empty message.
 */
const COMMIT_MESSAGE_MAX_TOKENS = 2_000;

/** Budget used when retrying a commit-message call that came back empty. */
const COMMIT_MESSAGE_RETRY_MAX_TOKENS = 2_000;

/**
 * Extract the model's visible answer from an assistant message. Some models
 * emit their deliberation inside a leading `<think>…</think>` block (or as an
 * unterminated `<think>` when truncated); that preamble is not a commit
 * message, so it is stripped when it precedes real text, and treated as empty
 * when it is all the model produced.
 */
function commitMessageText(response: AssistantMessage): string {
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) return "";
  const closed = /^<think>[\s\S]*?<\/think>\s*/u.exec(text);
  if (closed) return text.slice(closed[0].length).trim();
  if (/^<think>/u.test(text)) return "";
  return text;
}

/**
 * Model override for the empty-result retry. Some OpenAI-compatible endpoints
 * (DeepSeek-style `thinking` extension) spend the whole output budget on
 * hidden reasoning and never emit an answer; forcing the extension off makes
 * the model produce visible text. The override is inert for APIs that ignore
 * the compat key, and endpoints that reject the param simply error out — the
 * caller falls back to a patch-derived message in that case.
 */
function commitMessageRetryModel(model: Model<any>): Model<any> {
  if (model.api !== "openai-completions") return model;
  const compat = model.compat as OpenAICompletionsCompat | undefined;
  if (compat?.thinkingFormat === "deepseek") return model;
  return { ...model, compat: { ...compat, thinkingFormat: "deepseek" } };
}

/**
 * Deterministic fallback for when the model produces no usable text at all.
 * Derives a Conventional Commits message from the staged patch file headers,
 * so the user always gets something editable instead of a hard error.
 */
function fallbackCommitMessage(patch: string): string {
  const files: Array<{
    path: string;
    kind: "modified" | "added" | "deleted" | "renamed";
    fromPath?: string;
    additions: number;
    deletions: number;
  }> = [];
  let current: (typeof files)[number] | null = null;
  let renameFrom: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match =
        /^diff --git a\/(.*?) b\/(.*)$/u.exec(line) ?? /^diff --git (.*?) (.*)$/u.exec(line);
      if (!match) continue;
      const fromPath = match[1] === "/dev/null" ? undefined : match[1];
      const toPath = match[2] === "/dev/null" ? undefined : match[2];
      if (current) files.push(current);
      current = {
        path: toPath ?? fromPath ?? match[2] ?? "",
        kind: "modified",
        fromPath,
        additions: 0,
        deletions: 0,
      };
      renameFrom = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.kind = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.kind = "deleted";
    } else if (line.startsWith("rename from ")) {
      renameFrom = line.slice("rename from ".length);
      current.kind = "renamed";
      current.fromPath = renameFrom;
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.kind = "renamed";
      current.fromPath = renameFrom ?? current.fromPath;
    } else if (/^\+(?!\+)/u.test(line)) {
      current.additions += 1;
    } else if (/^-(?!-)/u.test(line)) {
      current.deletions += 1;
    }
  }
  if (current) files.push(current);

  if (files.length === 0) return "chore: 更新代码";

  const kindLabel = (kind: (typeof files)[number]["kind"]): string => {
    switch (kind) {
      case "added":
        return "新增";
      case "deleted":
        return "删除";
      case "renamed":
        return "重命名";
      default:
        return "修改";
    }
  };
  const MAX_LISTED = 10;
  const bullets = files.slice(0, MAX_LISTED).map((file) => {
    const name =
      file.kind === "renamed" && file.fromPath ? `${file.fromPath} → ${file.path}` : file.path;
    const stats =
      file.additions > 0 && file.deletions > 0
        ? `（+${file.additions} -${file.deletions}）`
        : file.additions > 0
          ? `（+${file.additions}）`
          : file.deletions > 0
            ? `（-${file.deletions}）`
            : "";
    return `- ${kindLabel(file.kind)} ${name}${stats}`;
  });
  const hidden = files.length - MAX_LISTED;
  if (hidden > 0) bullets.push(`- 以及其他 ${hidden} 个文件`);

  return [`chore: 更新 ${files.length} 个文件`, "", ...bullets].join("\n");
}

export function createGitHandlers(
  factory: WorkspaceGraphFactory,
  service: GitService,
): Partial<Record<string, MethodHandler>> {
  const emitSnapshot = (snapshot: GitStatusSnapshot) => {
    factory.getServer()?.emit("git.changed", { snapshot });
  };

  return {
    "git.getStatus": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      try {
        const result = await service.getStatus(root);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.setWatching": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      const server = factory.getServer();
      if (!root || !server) {
        return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      }
      const params = ctx.params as { enabled: boolean };
      const identity = server.getIdentity();
      try {
        const result = await service.setWatching(params.enabled, root, (snapshot) => {
          const current = factory.getGraph();
          const currentServer = factory.getServer();
          if (
            !current ||
            !currentServer ||
            current.workspaceId !== identity.workspaceId ||
            current.revision !== identity.workspaceRevision ||
            current.canonicalCwd !== root
          ) {
            return;
          }
          currentServer.emitForIdentity(identity, "git.changed", { snapshot });
        });
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfter) {
          service.stopWatching();
          return { error: staleAfter };
        }
        return { result };
      } catch (error) {
        service.stopWatching();
        return { error: hostError(error) };
      }
    },

    "git.getDiff": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as {
        path: string;
        area: "staged" | "unstaged";
        expectedRevision: number;
      };
      try {
        const result = await service.getDiff(
          root,
          params.path,
          params.area,
          params.expectedRevision,
        );
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.listBranches": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      try {
        const result = await service.listBranches(root);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.listHistory": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { limit: number; cursor?: string };
      try {
        const result = await service.listHistory(root, params.limit, params.cursor);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.getCommitDiff": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { commitSha: string };
      try {
        const result = await service.getCommitDiff(root, params.commitSha);
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        return staleAfter ? { error: staleAfter } : { result };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.mutateHunk": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as {
            path: string;
            area: "staged" | "unstaged";
            hunkId: string;
            operation: "stage" | "unstage" | "discard";
            expectedRevision: number;
            expectedContentGeneration: string;
          };
          return service.mutateHunk(
            root,
            params.path,
            params.area,
            params.hunkId,
            params.operation,
            params.expectedRevision,
            params.expectedContentGeneration,
            signal,
          );
        },
        emitSnapshot,
      ),

    "git.stage": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.stage(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.stageAll": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { expectedRevision: number };
          return service.stageAll(root, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.unstage": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.unstage(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.unstageAll": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { expectedRevision: number };
          return service.unstageAll(root, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.discard": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { path: string; expectedRevision: number };
          return service.discard(root, params.path, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.commit": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { message: string; expectedIndexGeneration: string };
          return service.commit(root, params.message, params.expectedIndexGeneration, signal);
        },
        emitSnapshot,
      ),

    "git.generateCommitMessage": async (ctx) => {
      const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
      if (stale) return { error: stale };
      const root = workspace(factory);
      if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
      const params = ctx.params as { expectedIndexGeneration: string };
      const model = factory.getGraph()?.agentSession?.model;
      if (!model) {
        return {
          error: createHostError(
            "AGENT_NOT_READY",
            "No active session model to generate a message",
          ),
        };
      }
      try {
        const { patch, truncated } = await service.getStagedPatch(
          root,
          params.expectedIndexGeneration,
        );
        if (!patch.trim()) {
          return {
            error: createHostError("INVALID_REQUEST", "No staged changes to summarize"),
          };
        }
        const auth = await factory.deps.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          return { error: createHostError("AUTH_REQUIRED", auth.error) };
        }
        const context: Context = {
          systemPrompt: [
            "You write Git commit messages for a desktop coding agent.",
            "Write in Simplified Chinese.",
            "Use Conventional Commits: <type>(<scope>): <subject>, then a blank line and concise bullet points for the key changes.",
            "Keep the subject under 50 characters and imperative.",
            "Do not use markdown code fences, quotes, labels, or ending punctuation.",
            "Base the message only on the provided staged diff.",
          ].join(" "),
          messages: [
            {
              role: "user",
              content: [
                `Staged diff:\n\`\`\`diff\n${patch.slice(0, 20_000)}\n\`\`\``,
                truncated ? "Note: the diff was truncated, so the message may be incomplete." : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
              timestamp: Date.now(),
            },
          ],
        };
        const attempt = async (options: {
          maxTokens: number;
          reasoning?: "minimal";
          model?: Model<any>;
        }): Promise<AssistantMessage> => {
          const { model: attemptModel, ...rest } = options;
          return completeSimple(attemptModel ?? model, context, {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            timeoutMs: 30_000,
            maxRetries: 0,
            ...rest,
          });
        };
        const fail = (response: AssistantMessage): HostError =>
          createHostError(
            "INTERNAL_ERROR",
            response.errorMessage ?? `Commit message generation ${response.stopReason}`,
          );
        let response = await attempt({
          maxTokens: COMMIT_MESSAGE_MAX_TOKENS,
          reasoning: "minimal",
        });
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          return { error: fail(response) };
        }
        let message = commitMessageText(response);
        let fallback = false;
        if (!message) {
          // Reasoning models sometimes spend the whole token budget on hidden
          // thinking and emit no answer text. Retry once with the endpoint's
          // thinking extension disabled so the model has to produce an answer.
          response = await attempt({
            maxTokens: COMMIT_MESSAGE_RETRY_MAX_TOKENS,
            model: commitMessageRetryModel(model),
          });
          if (response.stopReason === "error" || response.stopReason === "aborted") {
            // Never hard-fail on the retry: derive a message from the patch so
            // the user always gets something editable.
            message = fallbackCommitMessage(patch);
            fallback = true;
          } else {
            message = commitMessageText(response);
            if (!message) {
              message = fallbackCommitMessage(patch);
              fallback = true;
            }
          }
        }
        const staleAfter = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfter) return { error: staleAfter };
        return {
          result: {
            message,
            ...(truncated ? { truncated: true } : {}),
            ...(fallback ? { fallback: true } : {}),
          },
        };
      } catch (error) {
        return { error: hostError(error) };
      }
    },

    "git.push": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => service.push(root, signal), emitSnapshot),

    "git.pull": async (ctx) =>
      mutateGit(factory, ctx, (root, signal) => service.pull(root, signal), emitSnapshot),

    "git.createBranch": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { name: string; expectedRevision: number };
          return service.createBranch(root, params.name, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),

    "git.switchBranch": async (ctx) =>
      mutateGit(
        factory,
        ctx,
        (root, signal) => {
          const params = ctx.params as { name: string; expectedRevision: number };
          return service.switchBranch(root, params.name, params.expectedRevision, signal);
        },
        emitSnapshot,
      ),
  };
}

async function mutateGit(
  factory: WorkspaceGraphFactory,
  ctx: Parameters<MethodHandler>[0],
  mutate: (
    root: string,
    signal: AbortSignal,
  ) => Promise<{ applied: true; snapshot?: GitStatusSnapshot }>,
  emitSnapshot: (snapshot: GitStatusSnapshot) => void,
) {
  const server = factory.getServer();
  if (!server) return { error: createHostError("HOST_NOT_READY", "Server not bound") };
  const stale = factory.checkIdentity(ctx.context, { requireWorkspace: true });
  if (stale) return { error: stale };

  try {
    return await withRegisteredGraphMutation({
      server,
      operationKind: "git.mutation",
      requestId: ctx.id,
      run: async ({ signal }) => {
        const staleAfterLock = factory.checkIdentity(ctx.context, { requireWorkspace: true });
        if (staleAfterLock) return { error: staleAfterLock };
        const root = workspace(factory);
        if (!root) return { error: createHostError("PROJECT_NOT_SELECTED", "No workspace") };
        try {
          const result = await mutate(root, signal);
          if (result.snapshot) emitSnapshot(result.snapshot);
          return { result };
        } catch (error) {
          return { error: hostError(error) };
        }
      },
    });
  } catch (error) {
    return { error: hostError(error) };
  }
}
