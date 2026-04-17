import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";
import type { SessionEntry } from "./types.js";

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), {
    recursive: true,
  });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export type SessionTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string; appended?: boolean }
  | { ok: false; reason: string };

export type SessionTranscriptUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
};

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  turnId?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return appendExactAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    turnId: params.turnId,
    updateMode: params.updateMode,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export async function appendExactAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  message: SessionTranscriptAssistantMessage;
  idempotencyKey?: string;
  turnId?: string;
  storePath?: string;
  updateMode?: SessionTranscriptUpdateMode;
}): Promise<SessionTranscriptAppendResult> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }
  if (params.message.role !== "assistant") {
    return { ok: false, reason: "message role must be assistant" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const normalizedKey = normalizeStoreSessionKey(sessionKey);
  const entry = (store[normalizedKey] ?? store[sessionKey]) as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: formatErrorMessage(err),
    };
  }

  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const explicitIdempotencyKey =
    params.idempotencyKey ??
    ((params.message as { idempotencyKey?: unknown }).idempotencyKey as string | undefined);
  const explicitTurnId =
    params.turnId ??
    ((params.message as { turnId?: unknown }).turnId as string | undefined) ??
    explicitIdempotencyKey;
  const existingMessageId = await transcriptFindAssistantMessageId(sessionFile, {
    turnId: explicitTurnId,
    idempotencyKey: explicitIdempotencyKey,
  });
  if (existingMessageId) {
    return {
      ok: true,
      sessionFile,
      messageId: existingMessageId,
      appended: false,
    };
  }

  const deliveryMeta = {
    visible: true,
    state: "sent",
    ...(explicitTurnId ? { turnId: explicitTurnId } : {}),
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
  };
  const message = {
    ...params.message,
    ...(explicitIdempotencyKey ? { idempotencyKey: explicitIdempotencyKey } : {}),
    ...(explicitTurnId ? { turnId: explicitTurnId } : {}),
    __openclaw: {
      ...(params.message as { __openclaw?: Record<string, unknown> }).__openclaw,
      delivery: {
        ...(
          params.message as {
            __openclaw?: { delivery?: Record<string, unknown> };
          }
        ).__openclaw?.delivery,
        ...deliveryMeta,
      },
    },
  } as Parameters<SessionManager["appendMessage"]>[0];
  const sessionManager = SessionManager.open(sessionFile);
  const messageId = sessionManager.appendMessage(message);

  switch (params.updateMode ?? "inline") {
    case "inline":
      emitSessionTranscriptUpdate({
        sessionFile,
        sessionKey,
        message,
        messageId,
      });
      break;
    case "file-only":
      emitSessionTranscriptUpdate(sessionFile);
      break;
    case "none":
      break;
  }
  return { ok: true, sessionFile, messageId, appended: true };
}

export async function readAssistantTurnDeliveryFromSessionTranscript(params: {
  transcriptPath: string;
  turnId?: string;
  idempotencyKey?: string;
}): Promise<{ messageId?: string; turnId?: string; idempotencyKey?: string } | undefined> {
  const turnId = params.turnId?.trim();
  const idempotencyKey = params.idempotencyKey?.trim();
  if (!turnId && !idempotencyKey) {
    return undefined;
  }

  try {
    const raw = await fs.promises.readFile(params.transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          message?: {
            role?: unknown;
            turnId?: unknown;
            idempotencyKey?: unknown;
            __openclaw?: {
              delivery?: { turnId?: unknown; idempotencyKey?: unknown };
            };
          };
        };
        const message = parsed.message;
        if (message?.role !== "assistant") {
          continue;
        }
        const messageTurnId =
          typeof message.turnId === "string"
            ? message.turnId
            : typeof message.__openclaw?.delivery?.turnId === "string"
              ? message.__openclaw.delivery.turnId
              : undefined;
        const messageIdempotencyKey =
          typeof message.idempotencyKey === "string"
            ? message.idempotencyKey
            : typeof message.__openclaw?.delivery?.idempotencyKey === "string"
              ? message.__openclaw.delivery.idempotencyKey
              : undefined;
        if (
          (turnId && messageTurnId === turnId) ||
          (idempotencyKey && messageIdempotencyKey === idempotencyKey)
        ) {
          return {
            ...(typeof parsed.id === "string" && parsed.id ? { messageId: parsed.id } : {}),
            ...(messageTurnId ? { turnId: messageTurnId } : {}),
            ...(messageIdempotencyKey ? { idempotencyKey: messageIdempotencyKey } : {}),
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function transcriptFindAssistantMessageId(
  transcriptPath: string,
  params: { turnId?: string; idempotencyKey?: string },
): Promise<string | undefined> {
  const match = await readAssistantTurnDeliveryFromSessionTranscript({
    transcriptPath,
    turnId: params.turnId,
    idempotencyKey: params.idempotencyKey,
  });
  return match?.messageId;
}
