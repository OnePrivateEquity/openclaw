import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();
const resolveSessionKeyFromResolveParamsMock = vi.fn();

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    readSessionMessages: (...args: unknown[]) => readSessionMessagesMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  };
});

vi.mock("../../agents/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/subagent-registry-read.js")>(
    "../../agents/subagent-registry-read.js",
  );
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

vi.mock("../sessions-resolve.js", () => ({
  resolveSessionKeyFromResolveParams: (...args: unknown[]) =>
    resolveSessionKeyFromResolveParamsMock(...args),
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessagesMock.mockReset();
    loadGatewaySessionRowMock.mockReset();
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
    resolveSessionKeyFromResolveParamsMock.mockReset();
  });

  it("reactivates completed subagent sessions before broadcasting sessions.changed", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    };

    loadSessionEntryMock.mockReturnValue({
      canonicalKey: childSessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-followup" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);
    loadGatewaySessionRowMock.mockReturnValue({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });

    const broadcastToConnIds = vi.fn();
    const respond = vi.fn() as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    } as unknown as GatewayRequestContext;

    await sessionsHandlers["sessions.send"]({
      req: { id: "req-1" } as never,
      params: {
        key: childSessionKey,
        message: "follow-up",
        idempotencyKey: "run-new",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: "run-new",
        status: "started",
        messageSeq: 1,
      }),
      undefined,
      undefined,
    );
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
    });
  });

  it("accepts session.message and resolves sessionKey aliases before delegating to chat.send", async () => {
    resolveSessionKeyFromResolveParamsMock.mockResolvedValue({
      ok: true,
      key: "agent:soc:discord:direct:123",
    });
    loadSessionEntryMock.mockReturnValue({
      canonicalKey: "agent:soc:discord:direct:123",
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-123" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-1", status: "started" }, undefined, undefined);
    });

    const respond = vi.fn() as unknown as RespondFn;
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    } as unknown as GatewayRequestContext;

    await sessionsHandlers["session.message"]({
      req: { id: "req-2" } as never,
      params: {
        sessionKey: "agent:soc:discord:direct:123",
        message: "hello",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(resolveSessionKeyFromResolveParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        p: expect.objectContaining({ key: "agent:soc:discord:direct:123" }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        accepted: true,
        sessionKey: "agent:soc:discord:direct:123",
        deliveryState: "accepted",
        runId: "run-1",
      }),
      undefined,
      undefined,
    );
  });
});
