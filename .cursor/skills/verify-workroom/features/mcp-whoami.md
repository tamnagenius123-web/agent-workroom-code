# MCP whoami

`POST /mcp` with `tools/call` `workroom_whoami` returns 503 `AUTH_NOT_CONFIGURED`. `g5Authenticate` throws before a tool runs.

No `Authorization` header is sent. `evidence/pinned-discovery/whoami.json` records the status and the error code.
