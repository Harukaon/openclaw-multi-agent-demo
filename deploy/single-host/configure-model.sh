#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${FEEDMOB_API_KEY:?set FEEDMOB_API_KEY only in the local shell}"

api_base_url="${FEEDMOB_API_BASE_URL:-http://api.feedmob.it.com}"
api_base_url="${api_base_url%/}"
case "$api_base_url" in
  */v1) ;;
  *) api_base_url="$api_base_url/v1" ;;
esac

base_dir="$(cd "$(dirname "$0")" && pwd)"
for agent_dir in agent-a agent-b agent-c; do
  template="$base_dir/config/$agent_dir/openclaw.json.template"
  config="$base_dir/config/$agent_dir/openclaw.json"
  tmp="$(mktemp "$config.XXXXXX")"
  jq --arg apiKey "$FEEDMOB_API_KEY" --arg baseUrl "$api_base_url" '
    .models = ((.models // {}) + {
      mode: "merge",
      providers: ((.models.providers // {}) + {
        feedmob: {
          baseUrl: $baseUrl,
          api: "openai-completions",
          timeoutSeconds: 120,
          apiKey: $apiKey,
          models: [{ id: "minimax-m3", name: "MiniMax M3", reasoning: false }]
        }
      })
    })
    | .agents = ((.agents // {}) + { defaults: ((.agents.defaults // {}) + { model: { primary: "feedmob/minimax-m3" } }) })
  ' "$template" > "$tmp"
  mv "$tmp" "$config"
done
unset FEEDMOB_API_KEY
printf '%s\n' 'MiniMax M3 configured for Atlas, Nova, and Orion'
