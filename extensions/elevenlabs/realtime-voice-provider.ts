import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  type RealtimeVoiceAudioFormat,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  getRealtimeVoiceProvider,
  type RealtimeVoiceRole,
  type RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveElevenLabsApiKeyWithProfileFallback } from "./config-api.js";
import { normalizeElevenLabsBaseUrl } from "./shared.js";

const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_OUTPUT_FORMAT = "ulaw_8000";
const DEFAULT_TTS_TIMEOUT_MS = 20_000;
const DEFAULT_BRAIN_PROVIDER = "openai";

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
};

type ElevenLabsRealtimeVoiceConfig = {
  apiKey?: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  optimizeStreamingLatency?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  ttsTimeoutMs: number;
  voiceSettings: typeof DEFAULT_VOICE_SETTINGS;
  brainProvider: string;
  brain: RealtimeVoiceProviderConfig;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  const next =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : undefined;
  return Number.isFinite(next) ? next : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readNestedElevenLabsConfig(
  rawConfig: RealtimeVoiceProviderConfig,
): Record<string, unknown> {
  const raw = readRecord(rawConfig) ?? {};
  const providers = readRecord(raw.providers);
  return readRecord(providers?.elevenlabs ?? raw.elevenlabs ?? raw) ?? {};
}

function normalizeProviderConfig(
  rawConfig: RealtimeVoiceProviderConfig,
): ElevenLabsRealtimeVoiceConfig {
  const raw = readNestedElevenLabsConfig(rawConfig);
  const voiceSettings = readRecord(raw.voiceSettings) ?? {};
  const brainProvider = normalizeOptionalString(raw.brainProvider) ?? DEFAULT_BRAIN_PROVIDER;
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: raw.apiKey,
        path: "plugins.entries.voice-call.config.realtime.providers.elevenlabs.apiKey",
      }) ??
      resolveElevenLabsApiKeyWithProfileFallback() ??
      undefined,
    baseUrl: normalizeElevenLabsBaseUrl(normalizeOptionalString(raw.baseUrl)),
    voiceId: normalizeOptionalString(raw.voiceId) ?? DEFAULT_ELEVENLABS_VOICE_ID,
    modelId: normalizeOptionalString(raw.modelId ?? raw.model) ?? DEFAULT_ELEVENLABS_MODEL_ID,
    outputFormat:
      normalizeOptionalString(raw.outputFormat ?? raw.output_format) ?? DEFAULT_OUTPUT_FORMAT,
    optimizeStreamingLatency: readFiniteNumber(
      raw.optimizeStreamingLatency ?? raw.optimize_streaming_latency,
    ),
    applyTextNormalization: normalizeOptionalString(
      raw.applyTextNormalization ?? raw.apply_text_normalization,
    ) as "auto" | "on" | "off" | undefined,
    languageCode: normalizeOptionalString(raw.languageCode ?? raw.language_code),
    ttsTimeoutMs:
      readFiniteNumber(raw.ttsTimeoutMs ?? raw.tts_timeout_ms) ?? DEFAULT_TTS_TIMEOUT_MS,
    voiceSettings: {
      stability: readFiniteNumber(voiceSettings.stability) ?? DEFAULT_VOICE_SETTINGS.stability,
      similarityBoost:
        readFiniteNumber(voiceSettings.similarityBoost ?? voiceSettings.similarity_boost) ??
        DEFAULT_VOICE_SETTINGS.similarityBoost,
      style: readFiniteNumber(voiceSettings.style) ?? DEFAULT_VOICE_SETTINGS.style,
      useSpeakerBoost:
        readBoolean(voiceSettings.useSpeakerBoost ?? voiceSettings.use_speaker_boost) ??
        DEFAULT_VOICE_SETTINGS.useSpeakerBoost,
      speed: readFiniteNumber(voiceSettings.speed) ?? DEFAULT_VOICE_SETTINGS.speed,
    },
    brainProvider,
    brain: readRecord(raw.brain) ?? {},
  };
}

async function synthesizeElevenLabsSpeech(params: {
  config: ElevenLabsRealtimeVoiceConfig;
  text: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const { config, text, signal } = params;
  if (!config.apiKey) {
    throw new Error("ElevenLabs API key missing");
  }
  const url = new URL(`${config.baseUrl}/v1/text-to-speech/${config.voiceId}`);
  url.searchParams.set("output_format", config.outputFormat);
  if (config.optimizeStreamingLatency != null) {
    url.searchParams.set("optimize_streaming_latency", String(config.optimizeStreamingLatency));
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: config.modelId,
        apply_text_normalization: config.applyTextNormalization,
        language_code: config.languageCode,
        voice_settings: {
          stability: config.voiceSettings.stability,
          similarity_boost: config.voiceSettings.similarityBoost,
          style: config.voiceSettings.style,
          use_speaker_boost: config.voiceSettings.useSpeakerBoost,
          speed: config.voiceSettings.speed,
        },
      }),
      signal,
    },
    timeoutMs: config.ttsTimeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(config.baseUrl),
    auditContext: "elevenlabs.realtime-voice.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "ElevenLabs realtime voice TTS error");
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await release();
  }
}

class ElevenLabsRealtimeVoiceBridge implements RealtimeVoiceBridge {
  supportsToolResultContinuation?: boolean;
  private readonly brain: RealtimeVoiceBridge;
  private readonly config: ElevenLabsRealtimeVoiceConfig;
  private readonly audioFormat: RealtimeVoiceAudioFormat;
  private readonly pendingSyntheses = new Set<AbortController>();
  private closed = false;

  constructor(req: RealtimeVoiceBridgeCreateRequest) {
    this.config = normalizeProviderConfig(req.providerConfig);
    this.audioFormat = req.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
    if (this.audioFormat.encoding !== "g711_ulaw" || this.audioFormat.sampleRateHz !== 8000) {
      throw new Error("ElevenLabs realtime voice currently requires g711_ulaw 8kHz audio");
    }
    const brainProvider = getRealtimeVoiceProvider(this.config.brainProvider);
    if (!brainProvider) {
      throw new Error(
        `ElevenLabs realtime voice brain provider not found: ${this.config.brainProvider}`,
      );
    }
    this.brain = brainProvider.createBridge({
      ...req,
      providerConfig: this.config.brain,
      onAudio: () => {
        // ElevenLabs owns outbound audio; the brain provider owns STT/VAD/LLM/tools only.
      },
      onTranscript: (role, text, isFinal) => this.handleTranscript(req, role, text, isFinal),
      onClearAudio: () => {
        this.abortPendingSyntheses();
        req.onClearAudio();
      },
    });
    this.supportsToolResultContinuation = this.brain.supportsToolResultContinuation;
  }

  async connect(): Promise<void> {
    await this.brain.connect();
  }

  sendAudio(audio: Buffer): void {
    this.brain.sendAudio(audio);
  }

  setMediaTimestamp(ts: number): void {
    this.brain.setMediaTimestamp(ts);
  }

  sendUserMessage(text: string): void {
    this.brain.sendUserMessage?.(text);
  }

  triggerGreeting(instructions?: string, trigger?: string): void {
    this.brain.triggerGreeting?.(instructions, trigger);
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    this.brain.submitToolResult(callId, result, options);
  }

  acknowledgeMark(): void {
    this.brain.acknowledgeMark();
  }

  close(): void {
    this.closed = true;
    this.abortPendingSyntheses();
    this.brain.close();
  }

  isConnected(): boolean {
    return this.brain.isConnected();
  }

  private handleTranscript(
    req: RealtimeVoiceBridgeCreateRequest,
    role: RealtimeVoiceRole,
    text: string,
    isFinal: boolean,
  ): void {
    req.onTranscript?.(role, text, isFinal);
    if (role !== "assistant" || !isFinal || !text.trim() || this.closed) {
      return;
    }
    void this.speak(req, text.trim());
  }

  private async speak(req: RealtimeVoiceBridgeCreateRequest, text: string): Promise<void> {
    const controller = new AbortController();
    this.pendingSyntheses.add(controller);
    try {
      const audio = await synthesizeElevenLabsSpeech({
        config: this.config,
        text,
        signal: controller.signal,
      });
      if (!this.closed && audio.length > 0) {
        req.onAudio(audio);
        req.onMark?.(`elevenlabs-${Date.now()}`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        req.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.pendingSyntheses.delete(controller);
    }
  }

  private abortPendingSyntheses(): void {
    for (const controller of this.pendingSyntheses) {
      controller.abort();
    }
    this.pendingSyntheses.clear();
  }
}

export function buildElevenLabsRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs Realtime Voice",
    autoSelectOrder: 20,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) => Boolean(normalizeProviderConfig(providerConfig).apiKey),
    createBridge: (req) => new ElevenLabsRealtimeVoiceBridge(req),
  };
}

export type { ElevenLabsRealtimeVoiceConfig };
