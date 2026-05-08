import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord } from "../types.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
}

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: vi.fn(),
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

function makeRealtimeProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"],
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
  };
}

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    provider?: Partial<VoiceCallProvider>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
  },
) {
  const config: VoiceCallRealtimeConfig = {
    enabled: true,
    streamPath: overrides?.streamPath ?? "/voice/stream/realtime",
    instructions: overrides?.instructions ?? "Be helpful.",
    toolPolicy: overrides?.toolPolicy ?? "safe-read-only",
    tools: overrides?.tools ?? [],
    providers: overrides?.providers ?? {},
    ...(overrides?.provider ? { provider: overrides.provider } : {}),
  };
  return new RealtimeCallHandler(
    config,
    {
      processEvent: vi.fn(),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    {
      name: "twilio",
      verifyWebhook: vi.fn(),
      parseWebhookEvent: vi.fn(),
      initiateCall: vi.fn(),
      hangupCall: vi.fn(),
      playTts: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      getCallStatus: vi.fn(),
      ...deps?.provider,
    } as unknown as VoiceCallProvider,
    deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge()),
    { apiKey: "test-key" },
    "/voice/webhook",
  );
}

const startRealtimeServer = async (
  handler: RealtimeCallHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook"));
  const match = payload.body.match(/wss:\/\/[^/]+(\/[^"]+)/);
  if (!match) {
    throw new Error("Failed to extract realtime stream path");
  }

  return await startUpgradeWsServer({
    urlPath: match[1],
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

describe("RealtimeCallHandler path routing", () => {
  it("uses the request host and stream path in TwiML", () => {
    const handler = makeHandler();
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "gateway.ts.net"));

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toMatch(
      /wss:\/\/gateway\.ts\.net\/voice\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("preserves a public path prefix ahead of serve.path", () => {
    const handler = makeHandler({ streamPath: "/custom/stream/realtime" });
    handler.setPublicUrl("https://public.example/api/voice/webhook");
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "127.0.0.1:3334"));

    expect(handler.getStreamPathPattern()).toBe("/api/custom/stream/realtime");
    expect(payload.body).toMatch(
      /wss:\/\/public\.example\/api\/custom\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("normalizes Twilio outbound realtime directions", async () => {
    let callbacks:
      | {
          onReady?: () => void;
        }
      | undefined;
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge();
      },
    );
    const processEvent = vi.fn();
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-outbound",
        provider: "twilio",
        direction: "outbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const payload = handler.buildTwiMLPayload(
      makeRequest("/voice/webhook"),
      new URLSearchParams({
        Direction: "outbound-dial",
        From: "+15550001234",
        To: "+15550009999",
      }),
    );
    const match = payload.body.match(/wss:\/\/[^/]+(\/[^"]+)/);
    if (!match) {
      throw new Error("Failed to extract realtime stream path");
    }
    const server = await startUpgradeWsServer({
      urlPath: match[1],
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-outbound", callSid: "CA-outbound" },
          }),
        );
        await vi.waitFor(() => {
          expect(createBridge).toHaveBeenCalled();
        });
        callbacks?.onReady?.();
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "call.initiated",
            direction: "outbound",
            from: "+15550001234",
            to: "+15550009999",
          }),
        );
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("submits continuing responses only for realtime agent consult calls", async () => {
    let callbacks:
      | {
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
        }
      | undefined;
    let resolveConsult: ((value: unknown) => void) | undefined;
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-tool",
        provider: "twilio",
        direction: "inbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    handler.registerToolHandler(
      "openclaw_agent_consult",
      () =>
        new Promise((resolve) => {
          resolveConsult = resolve;
        }),
    );
    handler.registerToolHandler("custom_lookup", async () => ({ ok: true }));
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-tool", callSid: "CA-tool" },
          }),
        );
        await vi.waitFor(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "Are the basement lights on?" },
        });

        await vi.waitFor(() => {
          expect(submitToolResult).toHaveBeenCalledWith(
            "consult-call",
            expect.objectContaining({
              status: "working",
              tool: "openclaw_agent_consult",
            }),
            { willContinue: true },
          );
        });
        expect(submitToolResult).toHaveBeenCalledTimes(1);

        resolveConsult?.({ text: "The basement lights are on." });

        await vi.waitFor(() => {
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "consult-call",
            {
              text: "The basement lights are on.",
            },
            undefined,
          );
        });

        submitToolResult.mockClear();
        callbacks?.onToolCall?.({
          itemId: "item-2",
          callId: "custom-call",
          name: "custom_lookup",
          args: {},
        });

        await vi.waitFor(() => {
          expect(submitToolResult).toHaveBeenCalledWith("custom-call", { ok: true }, undefined);
        });
        expect(submitToolResult).not.toHaveBeenCalledWith("custom-call", expect.anything(), {
          willContinue: true,
        });
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});

describe("RealtimeCallHandler websocket hardening", () => {
  it("passes outbound initial messages as deterministic realtime opening instructions", async () => {
    const triggerGreeting = vi.fn();
    let onReady: (() => void) | undefined;
    let bridgeRequest: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const callRecord: CallRecord = {
      callId: "call-outbound",
      providerCallId: "CA-outbound",
      provider: "twilio",
      direction: "outbound",
      state: "initiated",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: "Hi Nathan, this is Soc. I am calling to verify the same-mind voice fix.",
        mode: "conversation",
      },
    };
    const handler = makeHandler(undefined, {
      manager: {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => callRecord),
      },
      realtimeProvider: makeRealtimeProvider((req) => {
        bridgeRequest = req;
        onReady = req.onReady;
        return {
          ...makeBridge(),
          connect: async () => {
            onReady?.();
          },
          triggerGreeting,
        };
      }),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-outbound",
              callSid: "CA-outbound",
            },
          }),
        );

        await vi.waitFor(() => expect(triggerGreeting).toHaveBeenCalledTimes(1));
        const instructions = triggerGreeting.mock.calls[0]?.[0] as string;
        expect(instructions).toContain("first spoken response MUST identify yourself");
        expect(instructions).toContain('Do not open with "How can I help you?"');
        expect(instructions).toContain("same-mind voice fix");
        expect(bridgeRequest?.instructions).toContain("call-scoped boot packet");
        expect(bridgeRequest?.instructions).toContain("Boot reason / opening identity");
        expect(bridgeRequest?.instructions).toContain("same-mind voice fix");
        expect(bridgeRequest?.instructions).toContain("If the caller asks who this is");
        expect(callRecord.metadata?.initialMessage).toBeUndefined();
        expect(callRecord.metadata?.realtimeBootReason).toContain("same-mind voice fix");
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("emits a Foresight first-utterance event from the first final assistant transcript", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const callRecord: CallRecord = {
      callId: "call-foresight-first",
      providerCallId: "CA-first",
      provider: "twilio",
      direction: "outbound",
      state: "initiated",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage:
          "Hi Nathan, this is Soc. I am calling to validate same-self voice boot behavior.",
        mode: "conversation",
        foresightVoiceSessionId: "vsn_first",
        foresightTraceId: "vtr_first",
        foresightRequiredFirstUtterance:
          "Hi Nathan, this is Soc. I am calling to validate same-self voice boot behavior.",
        foresightVoiceEventsUrl: "https://foresight.test/api/v2/internal/voice/events",
        foresightVoiceEventsToken: "secret-token",
        foresightBootPacket: { schemaVersion: 1, traceId: "vtr_first" },
      },
    };
    const handler = makeHandler(undefined, {
      manager: {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => callRecord),
      },
      realtimeProvider: makeRealtimeProvider((req) => {
        callbacks = req;
        return makeBridge({
          connect: async () => {
            req.onReady?.();
          },
        });
      }),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-first",
              callSid: "CA-first",
            },
          }),
        );

        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onTranscript?.(
          "assistant",
          "Hi Nathan, this is Soc. I am calling to validate same-self voice boot behavior.",
          true,
        );

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("https://foresight.test/api/v2/internal/voice/events");
        expect(init.headers).toMatchObject({
          authorization: "Bearer secret-token",
        });
        const body = JSON.parse(String(init.body));
        expect(body.eventType).toBe("voice.boot.first_utterance.spoken");
        expect(body.voiceSessionId).toBe("vsn_first");
        expect(body.traceId).toBe("vtr_first");
        expect(body.payload.text).toContain("same-self voice boot");
        expect(body.payload.matchedRequiredFirstUtterance).toBe(true);
        expect(body.payload.bootPacket.traceId).toBe("vtr_first");

        callbacks?.onTranscript?.("assistant", "Second assistant turn.", true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });

  it("bridges simulated Twilio media stream audio in both directions", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const bridgeSendAudio = vi.fn();
    const callRecord: CallRecord = {
      callId: "call-sim",
      providerCallId: "CA-sim",
      provider: "twilio",
      direction: "outbound",
      state: "initiated",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: "Hi Nathan, this is Soc testing the media bridge.",
        mode: "conversation",
      },
    };
    const handler = makeHandler(undefined, {
      manager: {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => callRecord),
      },
      realtimeProvider: makeRealtimeProvider((req) => {
        callbacks = req;
        return makeBridge({
          connect: async () => {
            req.onReady?.();
          },
          sendAudio: bridgeSendAudio,
        });
      }),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "connected",
            protocol: "Call",
            version: "1.0.0",
          }),
        );
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-sim",
              callSid: "CA-sim",
              mediaFormat: {
                encoding: "audio/x-mulaw",
                sampleRate: 8000,
                channels: 1,
              },
            },
          }),
        );

        await vi.waitFor(() => expect(callbacks).toBeDefined());

        const callerAudio = Buffer.from([1, 2, 3, 4]);
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: "MZ-sim",
            media: { payload: callerAudio.toString("base64"), timestamp: "20" },
          }),
        );

        await vi.waitFor(() => {
          expect(bridgeSendAudio).toHaveBeenCalledWith(callerAudio);
        });

        const outboundFramePromise = withTimeout(
          new Promise<Record<string, unknown>>((resolve) => {
            ws.on("message", (data) => {
              const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
              if (parsed.event === "media") {
                resolve(parsed);
              }
            });
          }),
        );

        callbacks?.onAudio?.(Buffer.from([9, 8, 7]));

        const outboundFrame = await outboundFramePromise;
        expect(outboundFrame).toMatchObject({
          event: "media",
          streamSid: "MZ-sim",
          media: { payload: Buffer.from([9, 8, 7]).toString("base64") },
        });
        expect(callRecord.metadata?.realtimeDiagnostics).toMatchObject({
          connectedEventSeen: true,
          inboundMediaFrames: 1,
          inboundMediaBytes: callerAudio.length,
          outboundMediaFrames: 1,
          outboundMediaBytes: 3,
          openaiReady: true,
        });
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects oversized pre-start frames before bridge setup", async () => {
    const createBridge = vi.fn(() => makeBridge());
    const processEvent = vi.fn();
    const getCallByProviderCallId = vi.fn();
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-oversized",
              callSid: "CA-oversized",
              padding: "A".repeat(300 * 1024),
            },
          }),
        );

        const closed = await waitForClose(ws);

        expect(closed.code).toBe(1009);
        expect(createBridge).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
        expect(getCallByProviderCallId).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});
