#!/bin/bash
# ci-bridge-writer.sh — poll this run's chat-bridge-<run_id> artifacts and
# keep the responder's bootstrap file fresh with every leg's witness relay
# addrs. Replaces the inline gh-based loop: gh needs GH_TOKEN and fails
# SILENTLY inside 2>/dev/null | grep || true chains (observed: a whole run
# whose writer emitted nothing for 15 min — the responder saw zero witness
# addrs and every model leg timed out unanswered).
#
# Usage: GH_TOKEN=<token> ci-bridge-writer.sh <repo> <run_id> <out_file> <bridge_dir> [polls]
set -u
REPO=${1:?usage: ci-bridge-writer.sh <repo> <run_id> <out_file> <bridge_dir> [polls]}
RUN_ID=${2:?}
OUT=${3:?}
BRIDGE=${4:?}
POLLS=${5:-45}
API="https://api.github.com/repos/$REPO"
AUTH=()
[ -n "${GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GH_TOKEN")
mkdir -p "$BRIDGE" "$(dirname "$OUT")"
echo "bridge writer: run $RUN_ID -> $OUT (token: ${GH_TOKEN:+set})"
for i in $(seq 1 "$POLLS"); do
  IDS=$(curl -s --max-time 30 "${AUTH[@]}" "$API/actions/runs/$RUN_ID/artifacts?per_page=100" | python3 -c "
import json,sys
try:
    for a in json.load(sys.stdin).get('artifacts',[]):
        if a['name'].startswith('chat-bridge-$RUN_ID'): print(a['id'])
except Exception: pass")
  for id in $IDS; do
    rm -f "$BRIDGE/bridge.zip"
    if curl -sL --max-time 30 "${AUTH[@]}" "$API/actions/artifacts/$id/zip" -o "$BRIDGE/bridge.zip"; then
      mkdir -p "$BRIDGE/$id" && unzip -o -q "$BRIDGE/bridge.zip" -d "$BRIDGE/$id" 2>/dev/null || true
    fi
  done
  MERGED=$(cat "$BRIDGE"/*/chat-addrs 2>/dev/null | tr -d '\n' | sed 's/,$//')
  # the publisher peer joins the bootstrap once its peer file lands
  PUB_PEER=""
  [ -f "$(dirname "$OUT")/peer" ] && PUB_PEER="/ip4/127.0.0.1/tcp/4011/p2p/$(cat "$(dirname "$OUT")/peer")"
  RESP_BOOT=$(printf '%s,%s' "$PUB_PEER" "$MERGED" | sed 's/^,//; s/,$//')
  if [ -n "$MERGED" ]; then
    echo "chat bridge: $(echo "$MERGED" | tr ',' '\n' | grep -c .) witness addr(s) from $(ls -d "$BRIDGE"/*/ 2>/dev/null | wc -l) leg(s) (poll $i/$POLLS)"
  else
    echo "::warning::no chat bridge artifact yet -- public-swarm fallback only (poll $i/$POLLS)"
  fi
  printf '%s' "$RESP_BOOT" > "$OUT"
  sleep 20
done
