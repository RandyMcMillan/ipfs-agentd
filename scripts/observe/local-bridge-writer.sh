#!/bin/bash
# local-bridge-writer.sh — follow a CI interop run's chat-bridge artifacts and
# keep a local responder's bootstrap file fresh, so a locally run
# scripts/chat-responder.mjs sees the legs' witnesses the same way the
# live-interop job's responder does (the public gnostr mesh alone carries
# nothing). Usage: local-bridge-writer.sh <run_id>
set -u
RUN_ID=${1:?usage: local-bridge-writer.sh <run_id>}
DIR=/mnt/agents/ipfs-agentd/scripts/observe
OUT="$DIR/local-bridge-bootstrap"
API=https://api.github.com/repos/RandyMcMillan/ipfs-agentd
# auth: artifact LIST is public but DOWNLOAD requires a token (fine-grained
# PAT, Actions: read). Read from $GH_TOKEN, else /mnt/agents/output/gh-token.
TOKEN=${GH_TOKEN:-}
[ -z "$TOKEN" ] && [ -f /mnt/agents/output/gh-token ] && TOKEN=$(cat /mnt/agents/output/gh-token)
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")
mkdir -p "$DIR"
echo "bridge writer: run $RUN_ID -> $OUT (token: ${TOKEN:+yes})"
while true; do
  IDS=$(curl -s --max-time 30 "${AUTH[@]}" "$API/actions/runs/$RUN_ID/artifacts" | python3 -c "
import json,sys
try:
    for a in json.load(sys.stdin).get('artifacts',[]):
        if a['name'].startswith('chat-bridge-$RUN_ID'): print(a['id'])
except Exception: pass" 2>/dev/null)
  MERGED=""
  for id in $IDS; do
    rm -f /tmp/bridge.zip
    if curl -sL --max-time 30 "${AUTH[@]}" "$API/actions/artifacts/$id/zip" -o /tmp/bridge.zip 2>/dev/null; then
      A=$(unzip -p /tmp/bridge.zip chat-addrs 2>/dev/null | tr -d '\n' | sed 's/,$//')
      [ -n "$A" ] && MERGED="$MERGED,$A"
    fi
  done
  MERGED=${MERGED#,}
  echo "$MERGED" > "$OUT"
  echo "$(date +%H:%M:%S) bridge addrs: $(printf '%s' "$MERGED" | tr ',' '\n' | grep -c . 2>/dev/null || echo 0) (run $RUN_ID)"
  sleep 20
done
