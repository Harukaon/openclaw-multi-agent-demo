#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${FEEDMOB_API_KEY:?set FEEDMOB_API_KEY only in the local shell}"

api_base_url="${FEEDMOB_API_BASE_URL:-https://new-api.pierce.wzizai.com}"
api_base_url="${api_base_url%/}"
case "$api_base_url" in
  */v1) ;;
  *) api_base_url="$api_base_url/v1" ;;
esac

base_dir="$(cd "$(dirname "$0")" && pwd)"
for config in "$base_dir"/config/agent-*/openclaw.json; do
  [ -f "$config" ] || continue
  template="${config%.json}.json.template"
  agent_dir="$(basename "$(dirname "$config")")"
  case "$agent_dir" in
    agent-a|agent-b)
      model_id="gpt-5.6-terra"
      model_name="GPT-5.6 Terra"
      ;;
    agent-c)
      model_id="grok-4.6"
      model_name="Grok 4.6"
      ;;
    *)
      printf 'unsupported Agent config: %s\n' "$agent_dir" >&2
      exit 1
      ;;
  esac
  tmp="$(mktemp "$config.XXXXXX")"
  jq --arg apiKey "$FEEDMOB_API_KEY" --arg baseUrl "$api_base_url" --arg modelId "$model_id" --arg modelName "$model_name" '
    .models = ((.models // {}) + {
      mode: "merge",
      providers: ((.models.providers // {}) + {
        feedmob: {
          baseUrl: $baseUrl,
          api: "openai-completions",
          timeoutSeconds: 120,
          apiKey: $apiKey,
          models: [{ id: $modelId, name: $modelName, reasoning: false }]
        }
      })
    })
    | .agents = ((.agents // {}) + { defaults: ((.agents.defaults // {}) + { model: { primary: ("feedmob/" + $modelId) } }) })
  ' "$template" > "$tmp"
  mv "$tmp" "$config"
done
unset FEEDMOB_API_KEY
printf '%s\n' 'GPT-5.6 Terra configured for Atlas/Nova; Grok 4.6 configured for Orion'
