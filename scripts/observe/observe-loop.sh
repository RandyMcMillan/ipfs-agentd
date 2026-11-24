#!/bin/bash
export PATH=/mnt/agents/opt/node-v22.23.5-linux-x64/bin:$PATH
cd /mnt/agents/ipfs-agentd
while true; do
  CHAT_TOPIC=gnostr CHAT_NEEDLE=gnostr-interop-question CHAT_TIMEOUT_MS=900000 \
    node scripts/listen-chat.mjs >> /mnt/agents/ipfs-agentd/scripts/observe/chat-verbose.log 2>&1
  echo "--- observer instance ended (rc=$?), relaunching ---" >> /mnt/agents/ipfs-agentd/scripts/observe/chat-verbose.log
  sleep 5
done
