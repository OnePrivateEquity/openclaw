# Security: Identity Enforcement for Agent Messaging

OpenClaw agents must not be able to silently send through another agent's messaging account or drive another agent's session unless that behavior is explicitly configured.

## Outbound message account binding

Each agent run has a resolved default messaging account (`agentAccountId`). The `message` tool now rejects calls that request a different `accountId` unless the calling agent is allowlisted:

```json5
{
  agents: {
    list: [
      {
        id: "soc",
        canImpersonateAccounts: ["carmack"]
      }
    ]
  }
}
```

If blocked, the tool returns a typed payload:

```json
{ "status": "forbidden", "code": "IDENTITY_ENFORCEMENT", "httpStatus": 403 }
```

This allowlist should be rare and audited. Use `"*"` only for controlled break-glass operator agents.

## Outbound audit log

Every outbound message action appends an audit record to:

```text
~/.openclaw/logs/outbound-audit.jsonl
```

Records include `sendingAgentId`, `sendingAccountId`, `originSessionKey`, and `botTokenMasked`, plus channel/action/target/dry-run metadata. Tokens are masked and are never written raw.

## Session visibility default

`tools.sessions.visibility` now defaults to `"own"`: an agent can see its own sessions but not sessions belonging to other agents.

Supported values:

- `self` — only the current session.
- `tree` — current session plus spawned subagent sessions.
- `own` / `agent` — any session for the current agent id.
- `agentAllowlist` — own sessions plus sessions for agents listed in `tools.sessions.agentAllowlist`.
- `all` — any session, still subject to agent-to-agent policy.

Example allowlist:

```json5
{
  tools: {
    sessions: {
      visibility: "agentAllowlist",
      agentAllowlist: ["soc", "carmack"]
    },
    agentToAgent: {
      enabled: true,
      allow: ["soc", "carmack"]
    }
  }
}
```

## Migration shim for `all`

Existing configs that already use `tools.sessions.visibility: "all"` are still honored. OpenClaw emits a one-time warning:

```text
[security] sessions.visibility=all is permissive; consider 'own' or 'agentAllowlist' for production
```

No automatic config rewrite is required. Operators should deliberately choose `all` only for trusted orchestration environments and prefer `own` or `agentAllowlist` for production-facing deployments.
