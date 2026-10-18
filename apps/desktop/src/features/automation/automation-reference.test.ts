/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { AutomationJob } from "@piabyss/protocol";
import {
  buildInjectedReferenceEnvelope,
  parseInjectedReferences,
} from "../chat/injected-references";
import { composeAutomationJobPayload } from "./automation-reference";

const job = {
  id: "j1",
  name: "每日构建报告",
  prompt: "总结昨天的提交",
  command: null,
  cwd: "/work/okxbot",
  enabled: true,
  permission: "read_only",
  model: null,
  trigger: { type: "interval", every: "1d" },
  missedWindow: "catch_up_one",
  timeoutMs: 1_800_000,
  maxRuns: null,
  loadExtensions: false,
  tags: ["构建"],
  notify: "system",
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
  lastStatus: null,
  runCount: 3,
  terminated: null,
} as unknown as AutomationJob;

describe("自动化引用胶囊", () => {
  it("正文带着现状与 jobId，草案卡才知道是改不是建", () => {
    const body = composeAutomationJobPayload(job);
    expect(body).toContain(`<automation-job id="j1">`);
    expect(body).toContain('"jobId": "j1"');
    expect(body).toContain('"runCount": 3');
    expect(body).toContain("每日构建报告");
  });

  it("展开成消息后只剩一张胶囊：那坨配置 JSON 不许出现在气泡、标题或复制文本里", () => {
    const message = buildInjectedReferenceEnvelope({
      kind: "automation-job",
      title: job.name,
      body: composeAutomationJobPayload(job),
    });

    const parsed = parseInjectedReferences(message);

    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.kind).toBe("automation-job");
    expect(parsed.references[0]?.title).toBe("每日构建报告");
    expect(parsed.text).toBe("");
  });

  it("用户自己说的话留在可见文本里", () => {
    const message =
      buildInjectedReferenceEnvelope({
        kind: "automation-job",
        title: job.name,
        body: composeAutomationJobPayload(job),
      }) + "\n改成每周一早上九点，只看主干。";

    const parsed = parseInjectedReferences(message);

    expect(parsed.references).toHaveLength(1);
    expect(parsed.text).toContain("改成每周一早上九点");
  });
});
