#!/usr/bin/env bash
# Launch agent:claude headless (`claude -p`) against the workroom MCP.
# CLAUDE_AUTH=subscription (default): Claude Max login; ANTHROPIC_API_KEY is unset for the child
#   so the subscription is used, never silently billed to the API.
# CLAUDE_AUTH=api: requires ANTHROPIC_API_KEY; metered.
# Usage: CLAUDE_AUTH=api scripts/claude-headless.sh "read unread workroom messages and reply"
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
prompt="${1:?prompt required}"
auth="${CLAUDE_AUTH:-subscription}"
args=(-p "$prompt" --mcp-config "${CLAUDE_MCP_CONFIG:-$here/config/claude-mcp.json}" --strict-mcp-config
      --output-format "${CLAUDE_OUTPUT_FORMAT:-json}" --allowedTools "${CLAUDE_ALLOWED_TOOLS:-mcp__workroom}")
[ -n "${CLAUDE_MODEL:-}" ] && args+=(--model "$CLAUDE_MODEL")
[ -n "${CLAUDE_MAX_TURNS:-}" ] && args+=(--max-turns "$CLAUDE_MAX_TURNS")
case "$auth" in
  subscription) exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude "${args[@]}" ;;
  api) : "${ANTHROPIC_API_KEY:?CLAUDE_AUTH=api needs ANTHROPIC_API_KEY}"; exec claude "${args[@]}" ;;
  *) echo "CLAUDE_AUTH must be subscription or api" >&2; exit 2 ;;
esac
