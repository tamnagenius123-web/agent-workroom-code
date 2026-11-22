# Pinned discovery

`wrangler.jsonc` keeps `WORKROOM_RESOURCE` at `https://agent-workroom-main.tamnagenius123.workers.dev/mcp`.

`GET /.well-known/oauth-authorization-server` and `GET /oauth/authorize` on that host return 503 `AUTH_NOT_CONFIGURED`. This repo does not publish an issuer document. The gate repo serves the real metadata.

The drive writes `evidence/pinned-discovery/discovery.json` with the status and the error code. It does not store a token.
