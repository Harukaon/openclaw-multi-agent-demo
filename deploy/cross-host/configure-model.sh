#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${FEEDMOB_API_KEY:?set FEEDMOB_API_KEY only in the local shell}"

base_dir="$(cd "$(dirname "$0")" && pwd)"
for config in "$base_dir"/config/agent-*/openclaw.json; do
  [ -f "$config" ] || continue
  template="${config%.json}.json.template"
  tmp="$(mktemp "$config.XXXXXX")"
  jq --arg apiKey "$FEEDMOB_API_KEY" '
    .models = ((.models // {}) + {
      mode: "merge",
      providers: ((.models.providers // {}) + {
        feedmob: {
          baseUrl: "http://api.feedmob.it.com/v1",
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
printf '%s\n' 'feedmob model configured in the local Agent config files'
