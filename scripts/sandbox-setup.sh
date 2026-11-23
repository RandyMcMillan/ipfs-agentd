#!/usr/bin/env bash
# sandbox-setup.sh — rebuild this dev environment from scratch in one shot.
#
# The sandbox periodically wipes /tmp, node_modules, and even .git — this
# script restores everything idempotently. Safe to run any number of times;
# each step skips itself when already in place.
#
#   scripts/sandbox-setup.sh           # full setup (deps, git, keys)
#   scripts/sandbox-setup.sh web       # + seed web-repos and start the
#                                      #   web app on $WEB_PORT (default 8901)
#
# Layout it relies on (persistent across sessions):
#   repo           /mnt/agents/ipfs-agentd
#   node 22        /mnt/agents/opt/node-v22.23.5-linux-x64
#   GPG key        /mnt/agents/output/gpg/private.asc   (key 3B696CCB)
#   SSH key        /mnt/agents/output/ssh/id_ed25519
#   web root       $WEB_ROOT (default /mnt/agents/output/web-repos)
set -eu
export PATH="/mnt/agents/opt/node-v22.23.5-linux-x64/bin:$PATH"

REPO=/mnt/agents/ipfs-agentd
GPG_ASC=/mnt/agents/output/gpg/private.asc
SSH_KEY=/mnt/agents/output/ssh/id_ed25519
WEB_ROOT=${WEB_ROOT:-/mnt/agents/output/web-repos}
WEB_PORT=${WEB_PORT:-8901}

step() { printf '\n== %s\n' "$*"; }

# --- node 22 ----------------------------------------------------------------
step "node"
if [ -x /mnt/agents/opt/node-v22.23.5-linux-x64/bin/node ]; then
  node --version
else
  echo "node 22 missing at /mnt/agents/opt — install per memory: rust/node persistent procedure"
  node --version || exit 1
fi

# --- .git (graft from origin when wiped) ------------------------------------
step "git"
cd "$REPO" || exit 1
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo ".git missing — grafting from origin"
  rm -rf /tmp/x-graft
  cloned=""
  for i in 1 2 3 4 5; do
    if git clone --depth 50 https://github.com/RandyMcMillan/ipfs-agentd /tmp/x-graft; then
      cloned=1; break
    fi
    echo "clone attempt $i failed — retrying in $((i*10))s"
    sleep $((i*10))
  done
  [ -n "$cloned" ] || { echo "FATAL: clone failed 5 times"; exit 1; }
  mv /tmp/x-graft/.git "$REPO/.git"
  rm -rf /tmp/x-graft
fi
# graft clones over https (no key in a fresh sandbox) — switch to the SSH
# remote so pushes use the persistent key from the first commit onward
git remote set-url origin git@github.com:RandyMcMillan/ipfs-agentd.git 2>/dev/null || true
git fetch origin 2>/dev/null || true
# a graft-time reset discards uncommitted work — keep a recoverable patch
if ! git diff --quiet 2>/dev/null; then
  git diff > /mnt/agents/output/pre-reset-backup.patch 2>/dev/null || true
  echo "WARNING: uncommitted changes discarded (patch saved to output/pre-reset-backup.patch)"
fi
git reset --hard origin/master
if git rev-parse --is-shallow-repository | grep -q true; then
  git fetch --unshallow origin || true
fi
git log --oneline -1

# --- GPG + git identity (unsigned commits must never happen) ----------------
step "gpg"
if ! gpg --batch --list-secret-keys 3B696CCB >/dev/null 2>&1; then
  [ -f "$GPG_ASC" ] && gpg --batch --import "$GPG_ASC"
  echo "8446780E8F3AE0E03D34118023639B203B696CCB:6:" | gpg --batch --import-ownertrust
fi
gpg --batch --list-secret-keys 3B696CCB >/dev/null 2>&1 && echo "signing key 3B696CCB present"
git config user.name  "Randy McMillan"
git config user.email "randy.lee.mcmillan@gmail.com"
git config user.signingkey 3B696CCB
git config commit.gpgsign true
[ -f "$SSH_KEY" ] && chmod 600 "$SSH_KEY" 2>/dev/null || true

# --- node deps ---------------------------------------------------------------
step "npm"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  echo "node_modules up to date"
fi

# --- web app -----------------------------------------------------------------
if [ "${1:-}" = "web" ]; then
  step "web app (root=$WEB_ROOT port=$WEB_PORT)"
  mkdir -p "$WEB_ROOT"
  if [ ! -d "$WEB_ROOT/ipfs-agentd/.git" ]; then
    rm -rf "$WEB_ROOT/ipfs-agentd"
    git clone --no-local "$REPO" "$WEB_ROOT/ipfs-agentd"
  fi
  git -C "$WEB_ROOT/ipfs-agentd" fetch --all -q || true
  pkill -f "[s]erve --root $WEB_ROOT" 2>/dev/null && sleep 2 || true
  (setsid nohup node src/bin.js serve --root "$WEB_ROOT" --port "$WEB_PORT" --publish \
     > /mnt/agents/output/web.log 2>&1 &)
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$WEB_PORT/" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 3
  done
  echo "web app: http://127.0.0.1:$WEB_PORT/ (HTTP $code)"
  tail -2 /mnt/agents/output/web.log
fi

step "done"
