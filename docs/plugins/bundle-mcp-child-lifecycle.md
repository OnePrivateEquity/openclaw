# Bundle MCP child lifecycle and gbrain

OpenClaw can load MCP servers declared by bundle plugins. Stdio MCP servers are child processes and must be treated as disposable: if startup times out, OpenClaw must close the transport and kill the child process tree.

## Failure mode fixed

Observed with gbrain:

1. bundle plugin declares `mcpServers.gbrain` with stdio command `./src/cli.ts serve`;
2. gbrain opens a local PGLite brain before completing MCP handshake;
3. PGLite lock/contention delays startup past the MCP connection timeout;
4. OpenClaw logs `MCP server connection timed out after 30000ms`;
5. timed-out stdio children can remain alive and compound future lock contention.

OpenClaw-side fix:

- `connectWithTimeout` now closes the transport when startup times out.
- stdio transport close kills the child process tree.
- bundle MCP server startups are serialized by server startup key so concurrent sessions do not stampede the same stdio command.

This does not replace plugin-side responsibility. Plugins should still complete stdio MCP handshake quickly and do expensive local DB work lazily.

## gbrain-specific expectations

Nathan's gbrain integration also carries a gbrain-side patch:

- stdio MCP handshakes before DB connect;
- first tool call connects the engine lazily;
- OpenClaw plugin metadata launches with `--no-retry-connect` and `GBRAIN_NO_RETRY_CONNECT=1`.

## Operational checks

After enabling or changing a bundle MCP plugin:

```bash
openclaw gateway restart
openclaw gateway status
journalctl --user -u openclaw-gateway.service --since '5 minutes ago' --no-pager \
  | grep -Ei 'bundle-mcp|gbrain|MCP server connection timed out'
pgrep -af 'src/cli.ts serve|gbrain.*serve'
```

Healthy state for gbrain:

- gateway active;
- at most one current `gbrain serve` child per active bundle MCP runtime;
- no fresh `MCP server connection timed out` after the startup window;
- fresh agent sessions still expose gbrain bundle skills.

## Cross-repo references

- gbrain integration note: `gbrain/docs/integrations/openclaw-mcp.md`
- Nathan operational patch queue: `openclaw-ops/vendor-patches/gbrain`
- Nathan upgrade plan: `openclaw-ops/docs/plans/GBRAIN-SKILLS-OPENCLAW-FORESIGHT-UPGRADE-PLAN-2026-05-09.md`
- Foresight skill adoption: `foresight-v2/docs/specialist-agents/GBRAIN-SKILLPACK-ADOPTION-AUDIT-2026-05-09.md`
