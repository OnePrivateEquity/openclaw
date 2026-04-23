import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export const IDENTITY_ENFORCEMENT_CODE = "IDENTITY_ENFORCEMENT" as const;

const log = createSubsystemLogger("identity-enforcement");

function normalizeAccount(value?: string | null): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function resolveAgentEntry(cfg: OpenClawConfig | undefined, agentId?: string) {
  const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
  if (!normalizedAgentId) {
    return undefined;
  }
  return cfg?.agents?.list?.find((entry) => normalizeAgentId(entry.id) === normalizedAgentId);
}

export function canAgentImpersonateAccount(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  targetAccountId?: string;
}): boolean {
  const target = normalizeAccount(params.targetAccountId);
  if (!target) {
    return false;
  }
  const entry = resolveAgentEntry(params.cfg, params.agentId);
  const allow = Array.isArray(entry?.canImpersonateAccounts) ? entry.canImpersonateAccounts : [];
  return allow.some((accountId) => {
    const normalized = normalizeAccount(accountId);
    return normalized === "*" || normalized === target;
  });
}

export function enforceMessageAccountIdentity(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  ownAccountId?: string;
  requestedAccountId?: string;
  sessionKey?: string;
}):
  | { allowed: true }
  | {
      allowed: false;
      payload: {
        status: "forbidden";
        code: typeof IDENTITY_ENFORCEMENT_CODE;
        httpStatus: 403;
        error: string;
        sendingAgentId?: string;
        sendingAccountId?: string;
        requestedAccountId?: string;
        originSessionKey?: string;
      };
    } {
  const own = normalizeAccount(params.ownAccountId);
  const requested = normalizeAccount(params.requestedAccountId);
  if (!own || !requested || own === requested) {
    return { allowed: true };
  }
  if (
    canAgentImpersonateAccount({
      cfg: params.cfg,
      agentId: params.agentId,
      targetAccountId: requested,
    })
  ) {
    return { allowed: true };
  }

  const payload = {
    status: "forbidden" as const,
    code: IDENTITY_ENFORCEMENT_CODE,
    httpStatus: 403 as const,
    error:
      `Identity enforcement blocked outbound message: agent account "${own}" ` +
      `cannot send as "${requested}". Add agents.list[].canImpersonateAccounts only for audited break-glass use.`,
    sendingAgentId: params.agentId,
    sendingAccountId: own,
    requestedAccountId: requested,
    originSessionKey: params.sessionKey,
  };
  log.warn("[security] blocked cross-account outbound message", payload);
  return { allowed: false, payload };
}
