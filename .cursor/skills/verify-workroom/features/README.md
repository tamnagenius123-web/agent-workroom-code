# Features this worker can prove

Hosted OAuth and MCP identity are served by the gate MCP repo. This repo's worker fail-closes those routes.

| Feature | What this tree proves |
| --- | --- |
| pinned-discovery | `/.well-known/oauth-authorization-server` and `/oauth/authorize` return 503 `AUTH_NOT_CONFIGURED`. |
| mcp-whoami | `POST /mcp` for `workroom_whoami` returns 503 `AUTH_NOT_CONFIGURED`. No bearer is sent. |
| room-message | A room write needs an identity this worker does not issue. The drive does not post a message. |
| git-disabled | `POST /git/merge` returns 503 `AUTH_NOT_CONFIGURED` before the route, and `WRGIT_ENABLED` stays `"0"`. |

The handover command is `node .cursor/skills/verify-workroom/scripts/drive-pinned-discovery.mjs`.
