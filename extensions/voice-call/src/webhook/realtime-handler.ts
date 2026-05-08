import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  type RealtimeVoiceAudioFormat,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { WebSocketServer } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";

export type ToolHandlerFn = (args: unknown, callId: string) => Promise<unknown>;

const STREAM_TOKEN_TTL_MS = 30_000;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;
const VOICE_BRIDGE_LOG_PREFIX = "[voice-bridge]";
const TWILIO_EXPECTED_MEDIA_FORMAT = {
  encoding: "audio/x-mulaw",
  sampleRate: 8000,
  channels: 1,
};

function logInfo(event: string, details: Record<string, unknown> = {}): void {
  console.info(`${VOICE_BRIDGE_LOG_PREFIX} ${JSON.stringify({ event, ...details })}`);
}

function logWarn(event: string, details: Record<string, unknown> = {}): void {
  console.warn(`${VOICE_BRIDGE_LOG_PREFIX} ${JSON.stringify({ event, ...details })}`);
}

function logError(event: string, details: Record<string, unknown> = {}): void {
  console.error(`${VOICE_BRIDGE_LOG_PREFIX} ${JSON.stringify({ event, ...details })}`);
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefixed === "/") {
    return prefixed;
  }
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return baseInstructions;
  }
  const intro =
    'You are starting a live phone call. Your first spoken response MUST identify yourself and state why you are calling. Use the following opening instruction as the actual first-turn content, not as vague background. Do not open with "How can I help you?" for an outbound call. Opening instruction:';
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

function buildCallScopedSessionInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return baseInstructions;
  }
  const sessionIdentity = [
    "This live phone call has a call-scoped boot packet. Treat it as durable context for the entire realtime session, not only the first turn.",
    `Boot reason / opening identity: "${trimmedGreeting}"`,
    "Continue as the same agent implied by that opening. If the opening identifies you by name, keep that identity throughout the call.",
    "If the caller asks who this is or why you called, answer directly from the boot reason/opening identity. Do not fall back to a generic assistant identity or say Nathan asked you to call unless the boot reason says that.",
  ].join("\n");
  return baseInstructions ? `${baseInstructions}\n\n${sessionIdentity}` : sessionIdentity;
}

function readMetadataString(call: CallRecord, key: string): string | undefined {
  const value = call.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMetadataRecord(call: CallRecord, key: string): Record<string, unknown> | undefined {
  const value = call.metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeComparableSpeech(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstUtteranceMatches(actual: string, required: string): boolean {
  const normalizedActual = normalizeComparableSpeech(actual);
  const normalizedRequired = normalizeComparableSpeech(required);
  return Boolean(
    normalizedActual &&
    normalizedRequired &&
    (normalizedActual.includes(normalizedRequired) ||
      normalizedRequired.includes(normalizedActual)),
  );
}

function sanitizeEventIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

async function postForesightVoiceEvent(params: {
  call: CallRecord;
  eventType: string;
  payload: Record<string, unknown>;
  providerCallId?: string;
}): Promise<void> {
  const url = readMetadataString(params.call, "foresightVoiceEventsUrl");
  const token = readMetadataString(params.call, "foresightVoiceEventsToken");
  const voiceSessionId = readMetadataString(params.call, "foresightVoiceSessionId");
  if (!url || !token || !voiceSessionId) {
    return;
  }

  const traceId = readMetadataString(params.call, "foresightTraceId");
  const occurredAt = new Date().toISOString();
  const eventId = `openclaw_${sanitizeEventIdSegment(params.eventType)}_${sanitizeEventIdSegment(
    voiceSessionId,
  )}_${Date.now()}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-foresight-timestamp": occurredAt,
    },
    body: JSON.stringify({
      eventId,
      eventType: params.eventType,
      voiceSessionId,
      openclawCallId: params.call.callId,
      twilioCallSid: params.providerCallId ?? params.call.providerCallId ?? null,
      traceId: traceId ?? null,
      occurredAt,
      payload: {
        ...params.payload,
        bootPacket: readMetadataRecord(params.call, "foresightBootPacket") ?? null,
      },
      source: "openclaw",
      schemaVersion: 1,
    }),
  });
  if (!response.ok) {
    throw new Error(`Foresight voice event POST failed: ${response.status}`);
  }
}

function sanitizeCloseReason(reason: Buffer, maxChars = 120): string {
  const text = reason
    .toString("utf8")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function pickRealtimeHeaders(headers: http.IncomingHttpHeaders): Record<string, unknown> {
  return {
    host: headers.host,
    upgrade: headers.upgrade,
    connection: headers.connection,
    userAgent: headers["user-agent"],
    xForwardedFor: headers["x-forwarded-for"],
    xTwilioSignaturePresent: Boolean(headers["x-twilio-signature"]),
    secWebSocketProtocol: headers["sec-websocket-protocol"],
  };
}

function describeRealtimeAudioFormat(format: RealtimeVoiceAudioFormat): Record<string, unknown> {
  return {
    encoding: format.encoding,
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
  };
}

function readMediaFormatField(mediaFormat: unknown, key: string): unknown {
  return mediaFormat && typeof mediaFormat === "object"
    ? (mediaFormat as Record<string, unknown>)[key]
    : undefined;
}

function isTwilioMulaw8k(mediaFormat: unknown): boolean {
  const encoding = String(readMediaFormatField(mediaFormat, "encoding") ?? "").toLowerCase();
  const sampleRate = Number(readMediaFormatField(mediaFormat, "sampleRate"));
  const channels = Number(readMediaFormatField(mediaFormat, "channels") ?? 1);
  return (
    (encoding === "audio/x-mulaw" ||
      encoding === "mulaw" ||
      encoding === "g711_ulaw" ||
      encoding === "g711-ulaw") &&
    sampleRate === TWILIO_EXPECTED_MEDIA_FORMAT.sampleRate &&
    channels === TWILIO_EXPECTED_MEDIA_FORMAT.channels
  );
}

function providerFormatMatchesTwilio(format: RealtimeVoiceAudioFormat): boolean {
  return format.encoding === "g711_ulaw" && format.sampleRateHz === 8000 && format.channels === 1;
}

function summarizeDiagnostics(diagnostics: RealtimeStreamDiagnostics): Record<string, unknown> {
  return {
    streamSid: diagnostics.streamSid,
    callSid: diagnostics.callSid,
    mediaFormat: diagnostics.mediaFormat,
    connectedEventSeen: diagnostics.connectedEventSeen,
    inboundMediaFrames: diagnostics.inboundMediaFrames,
    inboundMediaBytes: diagnostics.inboundMediaBytes,
    outboundMediaFrames: diagnostics.outboundMediaFrames,
    outboundMediaBytes: diagnostics.outboundMediaBytes,
    marksSent: diagnostics.marksSent,
    marksAcked: diagnostics.marksAcked,
    clearEventsSent: diagnostics.clearEventsSent,
    assistantFinalTranscripts: diagnostics.assistantFinalTranscripts,
    userFinalTranscripts: diagnostics.userFinalTranscripts,
    openaiReady: diagnostics.openaiReady,
    lastEvent: diagnostics.lastEvent,
    closeCode: diagnostics.closeCode,
    closeReason: diagnostics.closeReason,
    durationMs: Date.now() - diagnostics.startedAt,
  };
}

type PendingStreamToken = {
  expiry: number;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
  callSid?: string;
  preconnectedBridge?: PreparedRealtimeVoiceBridge;
};

type CallRegistration = {
  callId: string;
  callRecord: CallRecord;
  initialGreetingInstructions?: string;
  sessionInstructions?: string;
};

type RealtimeStreamDiagnostics = {
  streamSid: string;
  callSid: string;
  mediaFormat?: unknown;
  startedAt: number;
  connectedEventSeen: boolean;
  inboundMediaFrames: number;
  inboundMediaBytes: number;
  outboundMediaFrames: number;
  outboundMediaBytes: number;
  marksSent: number;
  marksAcked: number;
  clearEventsSent: number;
  assistantFinalTranscripts: number;
  userFinalTranscripts: number;
  openaiReady: boolean;
  lastEvent?: string;
  closeCode?: number;
  closeReason?: string;
  noOutboundMediaTimer?: ReturnType<typeof setTimeout>;
};

type TwilioStreamAttachment = {
  ws: WebSocket;
  streamSid: string;
  callSid: string;
  diagnostics: RealtimeStreamDiagnostics;
};

type PreparedRealtimeVoiceBridge = {
  session: RealtimeVoiceBridgeSession;
  callId: string;
  callRecord: CallRecord;
  attachTwilioStream(attachment: TwilioStreamAttachment): void;
  endCall(reason: "completed" | "error"): void;
  close(): void;
};

type ActiveRealtimeVoiceBridge = RealtimeVoiceBridgeSession;

export class RealtimeCallHandler {
  private readonly toolHandlers = new Map<string, ToolHandlerFn>();
  private readonly pendingStreamTokens = new Map<string, PendingStreamToken>();
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly provider: VoiceCallProvider,
    private readonly realtimeProvider: RealtimeVoiceProviderPlugin,
    private readonly providerConfig: RealtimeVoiceProviderConfig,
    private readonly servePath: string,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      const normalizedServePath = normalizePath(this.servePath);
      const normalizedPublicPath = normalizePath(parsed.pathname);
      const idx = normalizedPublicPath.indexOf(normalizedServePath);
      this.publicPathPrefix = idx > 0 ? normalizedPublicPath.slice(0, idx) : "";
    } catch {
      this.publicOrigin = null;
      this.publicPathPrefix = "";
    }
  }

  getStreamPathPattern(): string {
    return `${this.publicPathPrefix}${normalizePath(this.config.streamPath ?? "/voice/stream/realtime")}`;
  }

  buildTwiMLPayload(req: http.IncomingMessage, params?: URLSearchParams): WebhookResponsePayload {
    const host = this.publicOrigin || req.headers.host || DEFAULT_HOST;
    const rawDirection = params?.get("Direction");
    const callSidParam = params?.get("CallSid") ?? undefined;
    const tokenMeta: Omit<PendingStreamToken, "expiry"> = {
      from: params?.get("From") ?? undefined,
      to: params?.get("To") ?? undefined,
      direction: rawDirection?.startsWith("outbound") ? "outbound" : "inbound",
      callSid: callSidParam,
    };
    if (callSidParam) {
      tokenMeta.preconnectedBridge = this.preparePreconnectedBridge(callSidParam, tokenMeta);
    }
    const token = this.issueStreamToken(tokenMeta);
    const callSid = callSidParam ?? "unknown";
    const wsUrl = `wss://${host}${this.getStreamPathPattern()}/${token}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
    logInfo("twiml.generated", {
      callSid,
      direction: rawDirection ?? "unknown",
      streamUrl: wsUrl,
      twiml,
    });
    if (twiml.includes("<Start>") || twiml.includes("<Start ")) {
      logWarn("twiml.wrong_shape_start_stream", {
        callSid,
        streamUrl: wsUrl,
        twiml,
      });
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml,
    };
  }

  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "wss://localhost");
    const token = url.pathname.split("/").pop() ?? null;
    const callerMeta = token ? this.consumeStreamToken(token) : null;
    if (!callerMeta) {
      logWarn("twilio_ws.rejected", { path: url.pathname });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const wss = new WebSocketServer({
      noServer: true,
      // Reject oversized realtime frames before JSON parsing or bridge setup runs.
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: ActiveRealtimeVoiceBridge | null = null;
      let initialized = false;
      let diagnostics: RealtimeStreamDiagnostics | null = null;
      let connectedEventSeen = false;
      logInfo("twilio_ws.open", {
        callSid: callerMeta.callSid ?? "unknown",
        direction: callerMeta.direction ?? "unknown",
        remoteAddress: request.socket.remoteAddress,
        headers: pickRealtimeHeaders(request.headers),
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          const eventName = typeof msg.event === "string" ? msg.event : "unknown";
          if (diagnostics) {
            diagnostics.lastEvent = eventName;
          }
          if (eventName !== "media") {
            logInfo("twilio_ws.event", {
              callSid: diagnostics?.callSid ?? callerMeta.callSid ?? "unknown",
              eventType: eventName,
            });
          }
          if (!initialized && msg.event === "connected") {
            connectedEventSeen = true;
            logInfo("twilio_stream.connected", {
              callSid: callerMeta.callSid ?? "unknown",
            });
            return;
          }
          if (!initialized && msg.event === "start") {
            initialized = true;
            const startData =
              typeof msg.start === "object" && msg.start !== null
                ? (msg.start as Record<string, unknown>)
                : undefined;
            const streamSid =
              typeof startData?.streamSid === "string" ? startData.streamSid : "unknown";
            const callSid = typeof startData?.callSid === "string" ? startData.callSid : "unknown";
            diagnostics = {
              streamSid,
              callSid,
              mediaFormat: startData?.mediaFormat,
              startedAt: Date.now(),
              connectedEventSeen,
              inboundMediaFrames: 0,
              inboundMediaBytes: 0,
              outboundMediaFrames: 0,
              outboundMediaBytes: 0,
              marksSent: 0,
              marksAcked: 0,
              clearEventsSent: 0,
              assistantFinalTranscripts: 0,
              userFinalTranscripts: 0,
              openaiReady: false,
              lastEvent: "start",
            };
            const outboundAudioFormat = REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
            logInfo("twilio_stream.start", {
              callSid,
              streamSid,
              mediaFormat: startData?.mediaFormat ?? null,
              providerOutputAudioFormat: describeRealtimeAudioFormat(outboundAudioFormat),
            });
            if (!isTwilioMulaw8k(startData?.mediaFormat)) {
              logWarn("audio_format.twilio_unexpected", {
                callSid,
                streamSid,
                expected: TWILIO_EXPECTED_MEDIA_FORMAT,
                actual: startData?.mediaFormat ?? null,
              });
            }
            if (!providerFormatMatchesTwilio(outboundAudioFormat)) {
              logWarn("audio_format.provider_twilio_mismatch", {
                callSid,
                streamSid,
                twilioMediaFormat: startData?.mediaFormat ?? null,
                providerOutputAudioFormat: describeRealtimeAudioFormat(outboundAudioFormat),
              });
            }
            diagnostics.noOutboundMediaTimer = setTimeout(() => {
              if (diagnostics && diagnostics.outboundMediaFrames === 0) {
                logWarn("twilio_stream.no_outbound_media_after_5s", {
                  callSid,
                  streamSid,
                  inboundMediaFrames: diagnostics.inboundMediaFrames,
                  openaiReady: diagnostics.openaiReady,
                });
              }
            }, 5_000);
            const nextBridge = this.handleCall(streamSid, callSid, ws, callerMeta, diagnostics);
            if (!nextBridge) {
              return;
            }
            bridge = nextBridge;
            return;
          }
          if (!bridge) {
            return;
          }
          const mediaData =
            typeof msg.media === "object" && msg.media !== null
              ? (msg.media as Record<string, unknown>)
              : undefined;
          if (msg.event === "media" && typeof mediaData?.payload === "string") {
            const audio = Buffer.from(mediaData.payload, "base64");
            if (diagnostics) {
              diagnostics.inboundMediaFrames += 1;
              diagnostics.inboundMediaBytes += audio.length;
              if (
                diagnostics.inboundMediaFrames === 1 ||
                diagnostics.inboundMediaFrames % 50 === 0
              ) {
                logInfo("twilio_stream.media.inbound", {
                  callSid: diagnostics.callSid,
                  streamSid: diagnostics.streamSid,
                  frames: diagnostics.inboundMediaFrames,
                  bytes: diagnostics.inboundMediaBytes,
                });
              }
            }
            bridge.sendAudio(audio);
            if (typeof mediaData.timestamp === "number") {
              bridge.setMediaTimestamp(mediaData.timestamp);
            } else if (typeof mediaData.timestamp === "string") {
              bridge.setMediaTimestamp(Number.parseInt(mediaData.timestamp, 10));
            }
            return;
          }
          if (msg.event === "mark") {
            if (diagnostics) {
              diagnostics.marksAcked += 1;
              logInfo("twilio_stream.mark", {
                callSid: diagnostics.callSid,
                streamSid: diagnostics.streamSid,
                marksAcked: diagnostics.marksAcked,
              });
            }
            bridge.acknowledgeMark();
            return;
          }
          if (msg.event === "stop") {
            logInfo("twilio_stream.stop", {
              callSid: diagnostics?.callSid ?? callerMeta.callSid ?? "unknown",
              streamSid: diagnostics?.streamSid ?? "unknown",
            });
            bridge.close();
          }
        } catch (error) {
          logError("twilio_ws.parse_failed", {
            message: formatErrorMessage(error),
          });
        }
      });

      ws.on("close", (code, reason) => {
        if (diagnostics) {
          if (diagnostics.noOutboundMediaTimer) {
            clearTimeout(diagnostics.noOutboundMediaTimer);
            diagnostics.noOutboundMediaTimer = undefined;
          }
          diagnostics.closeCode = code;
          diagnostics.closeReason = Buffer.isBuffer(reason)
            ? sanitizeCloseReason(reason)
            : String(reason || "");
          logInfo("twilio_ws.close_summary", {
            callSid: diagnostics.callSid,
            code,
            reason: diagnostics.closeReason,
            summary: summarizeDiagnostics(diagnostics),
          });
          if (diagnostics.outboundMediaFrames === 0) {
            logWarn("twilio_ws.no_outbound_bot_audio", {
              callSid: diagnostics.callSid,
              inboundFrames: diagnostics.inboundMediaFrames,
              openaiReady: diagnostics.openaiReady,
            });
          }
        } else {
          logInfo("twilio_ws.close_before_start", { code });
        }
        bridge?.close();
      });

      ws.on("error", (error) => {
        logError("twilio_ws.error", { message: formatErrorMessage(error) });
      });
    });
  }

  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
  }

  private issueStreamToken(meta: Omit<PendingStreamToken, "expiry"> = {}): string {
    const token = randomUUID();
    this.pendingStreamTokens.set(token, {
      expiry: Date.now() + STREAM_TOKEN_TTL_MS,
      ...meta,
    });
    for (const [candidate, entry] of this.pendingStreamTokens) {
      if (Date.now() > entry.expiry) {
        entry.preconnectedBridge?.close();
        this.pendingStreamTokens.delete(candidate);
      }
    }
    return token;
  }

  private consumeStreamToken(token: string): Omit<PendingStreamToken, "expiry"> | null {
    const entry = this.pendingStreamTokens.get(token);
    if (!entry) {
      return null;
    }
    this.pendingStreamTokens.delete(token);
    if (Date.now() > entry.expiry) {
      entry.preconnectedBridge?.close();
      return null;
    }
    return {
      from: entry.from,
      to: entry.to,
      direction: entry.direction,
      callSid: entry.callSid,
      preconnectedBridge: entry.preconnectedBridge,
    };
  }

  private handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
    callerMeta: Omit<PendingStreamToken, "expiry">,
    diagnostics: RealtimeStreamDiagnostics,
  ): ActiveRealtimeVoiceBridge | null {
    const prepared =
      callerMeta.preconnectedBridge ?? this.prepareRealtimeBridge(callSid, callerMeta);
    if (!prepared) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    prepared.callRecord.metadata = {
      ...(prepared.callRecord.metadata ?? {}),
      realtimeDiagnostics: summarizeDiagnostics(diagnostics),
    };
    prepared.attachTwilioStream({ ws, streamSid, callSid, diagnostics });
    if (!callerMeta.preconnectedBridge) {
      this.connectPreparedBridge(prepared, callSid, ws);
    }
    return prepared.session;
  }

  private preparePreconnectedBridge(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry">,
  ): PreparedRealtimeVoiceBridge | undefined {
    const prepared = this.prepareRealtimeBridge(callSid, callerMeta);
    if (!prepared) {
      logWarn("realtime_voice.preconnect_skipped", { callSid, reason: "registration_failed" });
      return undefined;
    }
    logInfo("realtime_voice.preconnect_started", { callSid, callId: prepared.callId });
    this.connectPreparedBridge(prepared, callSid);
    return prepared;
  }

  private connectPreparedBridge(
    prepared: PreparedRealtimeVoiceBridge,
    callSid: string,
    ws?: WebSocket,
  ): void {
    prepared.session.connect().catch((error: Error) => {
      logError("realtime_voice.connect_failed", {
        callSid,
        message: error.message,
      });
      prepared.endCall("error");
      prepared.close();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.close(1011, "Failed to connect");
      }
    });
  }

  private prepareRealtimeBridge(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry">,
  ): PreparedRealtimeVoiceBridge | null {
    const registration = this.registerCallInManager(callSid, callerMeta);
    if (!registration) {
      return null;
    }

    const { callId, callRecord, initialGreetingInstructions, sessionInstructions } = registration;
    const hasInitialGreeting = Boolean(initialGreetingInstructions?.trim());
    let attachment: TwilioStreamAttachment | undefined;
    let ready = false;
    let connected = false;
    let greetingTriggered = false;
    let greetingFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let callEndEmitted = false;

    const updateDiagnostics = () => {
      if (!attachment) {
        return;
      }
      callRecord.metadata = {
        ...(callRecord.metadata ?? {}),
        realtimeDiagnostics: summarizeDiagnostics(attachment.diagnostics),
      };
    };
    const emitCallEnd = (reason: "completed" | "error") => {
      if (callEndEmitted) {
        return;
      }
      callEndEmitted = true;
      this.endCallInManager(callSid, callId, reason);
    };
    const triggerGreetingIfAttached = (trigger: string) => {
      if (!attachment || greetingTriggered) {
        return;
      }
      greetingTriggered = true;
      if (greetingFallbackTimer) {
        clearTimeout(greetingFallbackTimer);
        greetingFallbackTimer = undefined;
      }
      bridge.triggerGreeting(initialGreetingInstructions, trigger);
    };
    const scheduleGreetingFallbackIfAttached = () => {
      if (!attachment || ready || greetingTriggered || greetingFallbackTimer || !connected) {
        return;
      }
      greetingFallbackTimer = setTimeout(() => {
        triggerGreetingIfAttached("250ms fallback");
      }, 250);
    };

    const bridge = createRealtimeVoiceBridgeSession({
      provider: this.realtimeProvider,
      providerConfig: this.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
      instructions: sessionInstructions ?? this.config.instructions,
      tools: this.config.tools,
      initialGreetingInstructions,
      triggerGreetingOnReady: false,
      audioSink: {
        isOpen: () => attachment?.ws.readyState === WebSocket.OPEN,
        sendAudio: (muLaw) => {
          if (!attachment) {
            return;
          }
          const { ws, streamSid, diagnostics } = attachment;
          diagnostics.outboundMediaFrames += 1;
          diagnostics.outboundMediaBytes += muLaw.length;
          if (diagnostics.outboundMediaFrames === 1 && diagnostics.noOutboundMediaTimer) {
            clearTimeout(diagnostics.noOutboundMediaTimer);
            diagnostics.noOutboundMediaTimer = undefined;
          }
          updateDiagnostics();
          if (diagnostics.outboundMediaFrames === 1 || diagnostics.outboundMediaFrames % 50 === 0) {
            logInfo("twilio_stream.media.outbound", {
              callSid,
              streamSid,
              frames: diagnostics.outboundMediaFrames,
              bytes: diagnostics.outboundMediaBytes,
              ...(diagnostics.outboundMediaFrames === 1
                ? { latencyFromStartMs: Date.now() - diagnostics.startedAt }
                : {}),
            });
          }
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: muLaw.toString("base64") },
            }),
          );
        },
        clearAudio: () => {
          if (!attachment) {
            return;
          }
          attachment.diagnostics.clearEventsSent += 1;
          updateDiagnostics();
          attachment.ws.send(JSON.stringify({ event: "clear", streamSid: attachment.streamSid }));
        },
        sendMark: (markName) => {
          if (!attachment) {
            return;
          }
          attachment.diagnostics.marksSent += 1;
          updateDiagnostics();
          attachment.ws.send(
            JSON.stringify({
              event: "mark",
              streamSid: attachment.streamSid,
              mark: { name: markName },
            }),
          );
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (!isFinal) {
          return;
        }
        if (role === "user") {
          if (attachment) {
            attachment.diagnostics.userFinalTranscripts += 1;
            updateDiagnostics();
          }
          const event: NormalizedEvent = {
            id: `realtime-speech-${callSid}-${Date.now()}`,
            type: "call.speech",
            callId,
            providerCallId: callSid,
            timestamp: Date.now(),
            transcript: text,
            isFinal: true,
          };
          this.manager.processEvent(event);
          return;
        }
        if (attachment) {
          attachment.diagnostics.assistantFinalTranscripts += 1;
          updateDiagnostics();
        }
        const requiredFirstUtterance = readMetadataString(
          callRecord,
          "foresightRequiredFirstUtterance",
        );
        const shouldEmitFirstUtterance = Boolean(
          requiredFirstUtterance && !callRecord.metadata?.foresightFirstUtteranceEventEmitted,
        );
        if (shouldEmitFirstUtterance && callRecord.metadata) {
          callRecord.metadata.foresightFirstUtteranceEventEmitted = true;
        }
        this.manager.processEvent({
          id: `realtime-bot-${callSid}-${Date.now()}`,
          type: "call.speaking",
          callId,
          providerCallId: callSid,
          timestamp: Date.now(),
          text,
        });
        if (shouldEmitFirstUtterance && requiredFirstUtterance) {
          void postForesightVoiceEvent({
            call: callRecord,
            eventType: "voice.boot.first_utterance.spoken",
            providerCallId: callSid,
            payload: {
              text,
              requiredFirstUtterance,
              matchedRequiredFirstUtterance: firstUtteranceMatches(text, requiredFirstUtterance),
            },
          }).catch((error: unknown) => {
            logWarn("foresight_voice_event.post_failed", {
              callSid,
              eventType: "voice.boot.first_utterance.spoken",
              message: formatErrorMessage(error),
            });
          });
        }
      },
      onToolCall: (toolEvent, session) => {
        void this.executeToolCall(
          session,
          callId,
          toolEvent.callId || toolEvent.itemId,
          toolEvent.name,
          toolEvent.args,
        );
      },
      onReady: () => {
        ready = true;
        if (attachment) {
          attachment.diagnostics.openaiReady = true;
          updateDiagnostics();
        }
        logInfo("opening_turn.requested", {
          callId,
          providerCallId: callSid,
          reasonPresent: hasInitialGreeting,
          twilioStreamAttached: Boolean(attachment),
        });
        triggerGreetingIfAttached("session.updated");
      },
      onError: (error) => {
        logError("realtime_voice.error", {
          callSid,
          message: error.message,
        });
      },
      onClose: (reason) => {
        if (reason !== "error") {
          return;
        }
        emitCallEnd("error");
        if (attachment?.ws.readyState === WebSocket.OPEN) {
          attachment.ws.close(1011, "Bridge disconnected");
        }
        void this.provider
          .hangupCall({ callId, providerCallId: callSid, reason: "error" })
          .catch((error: unknown) => {
            console.warn(
              `${VOICE_BRIDGE_LOG_PREFIX} ${JSON.stringify({
                event: "realtime_voice.hangup_failed",
                callSid,
                message: formatErrorMessage(error),
              })}`,
            );
          });
      },
    });

    const prepared: PreparedRealtimeVoiceBridge = {
      session: bridge,
      callId,
      callRecord,
      attachTwilioStream: (nextAttachment) => {
        attachment = nextAttachment;
        if (ready) {
          attachment.diagnostics.openaiReady = true;
          updateDiagnostics();
          triggerGreetingIfAttached("session.updated");
        } else {
          updateDiagnostics();
          scheduleGreetingFallbackIfAttached();
        }
      },
      endCall: emitCallEnd,
      close: () => {
        if (greetingFallbackTimer) {
          clearTimeout(greetingFallbackTimer);
          greetingFallbackTimer = undefined;
        }
        bridge.close();
      },
    };

    const originalConnect = bridge.connect.bind(bridge);
    bridge.connect = async () => {
      await originalConnect();
      connected = true;
      scheduleGreetingFallbackIfAttached();
    };

    return prepared;
  }

  private registerCallInManager(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry"> = {},
  ): CallRegistration | null {
    const timestamp = Date.now();
    const baseFields = {
      providerCallId: callSid,
      timestamp,
      direction: callerMeta.direction ?? "inbound",
      ...(callerMeta.from ? { from: callerMeta.from } : {}),
      ...(callerMeta.to ? { to: callerMeta.to } : {}),
    };

    this.manager.processEvent({
      id: `realtime-initiated-${callSid}`,
      callId: callSid,
      type: "call.initiated",
      ...baseFields,
    });

    const callRecord = this.manager.getCallByProviderCallId(callSid);
    if (!callRecord) {
      return null;
    }

    const initialGreeting = this.extractInitialGreeting(callRecord);
    if (callRecord.metadata && initialGreeting) {
      callRecord.metadata.realtimeBootReason = initialGreeting;
      delete callRecord.metadata.initialMessage;
    }

    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId: callSid,
      type: "call.answered",
      ...baseFields,
    });

    return {
      callId: callRecord.callId,
      callRecord,
      initialGreetingInstructions: buildGreetingInstructions(
        this.config.instructions,
        initialGreeting,
      ),
      sessionInstructions: buildCallScopedSessionInstructions(
        this.config.instructions,
        initialGreeting,
      ),
    };
  }

  private extractInitialGreeting(call: CallRecord): string | undefined {
    return typeof call.metadata?.initialMessage === "string"
      ? call.metadata.initialMessage
      : undefined;
  }

  private endCallInManager(callSid: string, callId: string, reason: "completed" | "error"): void {
    this.manager.processEvent({
      id: `realtime-ended-${callSid}-${Date.now()}`,
      type: "call.ended",
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      reason,
    });
  }

  private async executeToolCall(
    bridge: ActiveRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    if (
      handler &&
      name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
      bridge.bridge.supportsToolResultContinuation
    ) {
      bridge.submitToolResult(
        bridgeCallId,
        buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
        { willContinue: true },
      );
    }
    const result = !handler
      ? { error: `Tool "${name}" not available` }
      : await handler(args, callId).catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
    bridge.submitToolResult(bridgeCallId, result);
  }
}
