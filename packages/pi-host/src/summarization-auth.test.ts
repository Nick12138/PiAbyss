/**
 * Compaction / branch-summary auth (PR-4; §11 gate "compaction/branch auth 失败").
 *
 * The summarization LLM call inside compact() and navigateTree({summarize})
 * resolves auth through _getSummarizationRequestAuth, whose failure mode is a
 * silent `{}` — the request would go out unauthenticated and the operation
 * would fail only at the upstream API. These tests run the real path: a real
 * AgentSession over the shared ModelRuntime, a provider whose streamSimple is
 * the wire boundary, and assertions that every summarization request actually
 * carries the provider's key and headers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createTestModelServices } from "./test-helpers/model-runtime.js";

const roots: string[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type CapturedCall = { apiKey?: string; headers?: Record<string, string> };

async function buildCaptureSession() {
  const root = mkdtempSync(join(tmpdir(), "piabyss-summarization-auth-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), "{}");
  // keepRecentTokens: 1 lets manual compact() find a cut point in a session
  // holding a single prompt exchange; the default 20k would refuse ("Nothing
  // to compact") long before any summarization request could be observed.
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
  );

  const { modelRuntime, modelRegistry } = await createTestModelServices(agentDir);

  const faux = createFauxCore({
    api: "piabyss-capture-api",
    provider: "capture",
    models: [
      {
        id: "capture-model",
        name: "Capture Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    // Effectively instant streaming; these tests assert auth, not pacing.
    tokensPerSecond: 1_000_000,
  });
  const response = () =>
    fauxAssistantMessage(fauxText("Deterministic capture response."), { stopReason: "stop" });
  faux.setResponses([response(), response(), response(), response(), response(), response()]);

  const captured: CapturedCall[] = [];
  modelRegistry.registerProvider("capture", {
    name: "Capture",
    api: faux.api,
    apiKey: "summarization-auth-key",
    baseUrl: "http://capture.invalid",
    headers: { "X-PiAbyss-Auth-Test": "wired" },
    streamSimple: ((model: never, context: never, options: CapturedCall) => {
      captured.push({ apiKey: options?.apiKey, headers: options?.headers });
      return (faux.streamSimple as (m: never, c: never, o: unknown) => unknown)(
        model,
        context,
        options,
      );
    }) as never,
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  sessions.push(session);

  const model = modelRegistry.find("capture", "capture-model");
  expect(model).toBeDefined();
  await session.setModel(model!);

  return { session, captured };
}

describe("summarization request auth", () => {
  it("sends the provider's key and headers on the compaction summarization call", async () => {
    const { session, captured } = await buildCaptureSession();

    await session.prompt("hello capture");
    expect(captured.length).toBeGreaterThan(0);
    const beforeCompact = captured.length;

    const result = await session.compact();
    expect(result).toBeDefined();

    const summarizationCalls = captured.slice(beforeCompact);
    expect(summarizationCalls.length).toBeGreaterThan(0);
    for (const call of summarizationCalls) {
      expect(call.apiKey).toBe("summarization-auth-key");
      expect(call.headers).toMatchObject({ "X-PiAbyss-Auth-Test": "wired" });
    }
  }, 60_000);

  it("sends the provider's key and headers on the branch-summary call", async () => {
    const { session, captured } = await buildCaptureSession();

    await session.prompt("first question");
    const forkPoints = session.getUserMessagesForForking();
    expect(forkPoints.length).toBeGreaterThan(0);
    const beforeBranch = captured.length;

    const result = await session.navigateTree(forkPoints[0]!.entryId, { summarize: true });
    expect(result.cancelled).toBe(false);

    const summarizationCalls = captured.slice(beforeBranch);
    expect(summarizationCalls.length).toBeGreaterThan(0);
    for (const call of summarizationCalls) {
      expect(call.apiKey).toBe("summarization-auth-key");
      expect(call.headers).toMatchObject({ "X-PiAbyss-Auth-Test": "wired" });
    }
  }, 60_000);
});
