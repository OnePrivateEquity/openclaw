import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";

let openaiCreateBridge: ReturnType<typeof vi.fn>;
let openaiCallbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;

vi.mock("../../src/realtime-voice/provider-registry.js", () => ({
  getRealtimeVoiceProvider: (id: string) => {
    if (id !== "openai") {
      return undefined;
    }
    return {
      id: "openai",
      label: "OpenAI test brain",
      isConfigured: () => true,
      createBridge: openaiCreateBridge,
    } satisfies RealtimeVoiceProviderPlugin;
  },
}));

import { buildElevenLabsRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("ElevenLabs realtime voice provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    openaiCallbacks = undefined;
  });

  it("uses OpenAI as the brain while ElevenLabs only receives assistant speech text", async () => {
    openaiCreateBridge = vi.fn((req) => {
      openaiCallbacks = req;
      return {
        supportsToolResultContinuation: true,
        connect: vi.fn(async () => req.onReady?.()),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        sendUserMessage: vi.fn(),
        triggerGreeting: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("Hello Nathan, this is Soc.");
      expect(String(init?.body)).not.toContain("same-self system prompt");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildElevenLabsRealtimeVoiceProvider();
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = provider.createBridge({
      providerConfig: {
        apiKey: "eleven-key",
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        brain: { apiKey: "openai-key", model: "gpt-realtime" },
      },
      instructions: "same-self system prompt from Foresight",
      onAudio,
      onClearAudio: vi.fn(),
      onTranscript,
    });

    await bridge.connect();
    expect(openaiCreateBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfig: expect.objectContaining({ apiKey: "openai-key" }),
        instructions: "same-self system prompt from Foresight",
      }),
    );

    openaiCallbacks?.onTranscript?.("assistant", "Hello Nathan, this is Soc.", true);
    await vi.waitFor(() => expect(onAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3])));
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Hello Nathan, this is Soc.", true);
  });

  it("does not synthesize partial assistant transcript deltas", async () => {
    openaiCreateBridge = vi.fn((req) => {
      openaiCallbacks = req;
      return {
        connect: vi.fn(async () => req.onReady?.()),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        sendUserMessage: vi.fn(),
        triggerGreeting: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      };
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const bridge = buildElevenLabsRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "eleven-key", brain: { apiKey: "openai-key" } },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    await bridge.connect();
    openaiCallbacks?.onTranscript?.("assistant", "partial", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
