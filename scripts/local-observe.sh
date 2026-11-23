#!/usr/bin/env bash
# local-observe.sh — local observation fleet for live interop runs.
#
# Runs three persistent local nodes against the real "gnostr" topic so a
# dispatch can be watched (and interacted with) from a developer machine:
#   listener   scripts/listen-gnostr.mjs — git ads / all topic traffic
#   observer   scripts/listen-chat.mjs (CHAT_NEEDLE) — every run-marked
#              question/answer envelope, verbatim, in chat-verbose.log
#   responder  scripts/chat-responder.mjs — answers ANY run's question from
#              this peer (name responder-<platform>) — set RESPONDER=0 to
#              watch without interacting
#
# A supervisor loop (this script's `supervise` mode, launched via start)
# relaunches any service that exits — listen-chat instances time out after
# CHAT_TIMEOUT_MS and are restarted, so observation runs indefinitely.
#
# Usage: scripts/local-observe.sh [start|stop|status|tail]
#   start    launch the fleet (default); idempotent
#   stop     stop the supervisor and every service (self-match-safe kills)
#   status   alive/dead per service + log paths
#   tail     tail -f all logs (Ctrl-C exits the tail only)
#
# Env:
#   NODE              node binary (default: node on PATH — must be >= 22,
#                     see AGENTS.md: node 20 crashes undici zstd)
#   GNOSTR_TOPIC      topic (default gnostr)
#   OBSERVE_NEEDLE    run-marker prefix to observe/answer (default
#                     gnostr-interop-question — matches EVERY run; suffixes
#                     don't matter because matching is substring-based)
#   RESPONDER=0       watch-only: do not answer questions from this peer
#   IPFS_OBSERVE_DIR  state/log dir (default $HOME/.ipfs-agentd-observe)
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-node}
TOPIC=${GNOSTR_TOPIC:-gnostr}
NEEDLE=${OBSERVE_NEEDLE:-gnostr-interop-question}
DIR=${IPFS_OBSERVE_DIR:-$HOME/.ipfs-agentd-observe}
PIDDIR=$DIR/pids
LOGDIR=$DIR/logs
mkdir -p "$PIDDIR" "$LOGDIR"

# --- node >= 22 check (node 20: undici zstd crash, see AGENTS.md) -----------
if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  echo "warning: $NODE is < 22 — the fleet will likely crash (undici zstd). Set NODE=/path/to/node-22." >&2
fi

svc_pidfile() { echo "$PIDDIR/$1.pid"; }
svc_alive() { [ -f "$(svc_pidfile "$1")" ] && kill -0 "$(cat "$(svc_pidfile "$1")")" 2>/dev/null; }

svc_launch() { # name logfile [NAME=value...] cmd [args...]
  local name=$1 log=$2; shift 2
  # race guard: mkdir is atomic — a concurrent supervisor iteration (or a
  # simultaneous `start`) holding the lock means we stand down
  local lock="$PIDDIR/.$name.launchlock"
  if ! mkdir "$lock" 2>/dev/null; then return 0; fi
  if svc_alive "$name"; then rmdir "$lock" 2>/dev/null; return 0; fi
  # leading NAME=value args become the child's environment (env(1) requires
  # assignments BEFORE the command — putting them after would pass them as
  # argv instead, and the scripts read process.env, not argv)
  local envargs=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do envargs+=("$1"); shift; done
  setsid nohup env GNOSTR_TOPIC="$TOPIC" LISTENER_REPO="$DIR/listener-repo" \
    "${envargs[@]}" "$@" >> "$LOGDIR/$log" 2>&1 < /dev/null &
  echo $! > "$(svc_pidfile "$name")"
  rmdir "$lock" 2>/dev/null
  echo "started $name (pid $!) — $LOGDIR/$log"
}

start_supervisor() {
  if svc_alive supervisor; then
    echo "supervisor already running (pid $(cat "$(svc_pidfile supervisor)"))"
    return 0
  fi
  # run via bash explicitly — mounts without exec bits can't $0 a script
  setsid nohup bash "$0" supervise >> "$LOGDIR/supervisor.log" 2>&1 < /dev/null &
  echo $! > "$(svc_pidfile supervisor)"
  echo "supervisor pid $!"
}

do_start() {
  start_supervisor
  # launch immediately too, so `start` gives instant feedback
  svc_launch listener listener.log "$NODE" scripts/listen-gnostr.mjs
  svc_launch observer chat-verbose.log CHAT_NEEDLE="$NEEDLE" CHAT_TIMEOUT_MS=900000 \
    "$NODE" scripts/listen-chat.mjs
  if [ "${RESPONDER:-1}" != "0" ]; then
    svc_launch responder responder.log INTEROP_TOPIC="$TOPIC" \
      INTEROP_QUESTION_MARKER="$NEEDLE" INTEROP_LIVE_SECS=900 \
      "$NODE" scripts/chat-responder.mjs
  fi
  echo "observing topic '$TOPIC', needle '$NEEDLE' (logs: $LOGDIR)"
}

do_supervise() { # internal: relaunch dead services every 15s, forever
  while true; do
    svc_alive listener   || svc_launch listener listener.log "$NODE" scripts/listen-gnostr.mjs
    svc_alive observer   || svc_launch observer chat-verbose.log CHAT_NEEDLE="$NEEDLE" \
                            CHAT_TIMEOUT_MS=900000 "$NODE" scripts/listen-chat.mjs
    if [ "${RESPONDER:-1}" != "0" ]; then
      svc_alive responder || svc_launch responder responder.log INTEROP_TOPIC="$TOPIC" \
                            INTEROP_QUESTION_MARKER="$NEEDLE" INTEROP_LIVE_SECS=900 \
                            "$NODE" scripts/chat-responder.mjs
    fi
    sleep 15
  done
}

do_stop() {
  # kill the supervisor first so it doesn't relaunch, then the services.
  # Bracket trick keeps pkill from matching THIS shell's own cmdline.
  for s in supervisor listener observer responder; do
    if svc_alive "$s"; then kill "$(cat "$(svc_pidfile "$s")")" 2>/dev/null; fi
    rm -f "$(svc_pidfile "$s")"
  done
  pkill -f "scripts/[l]isten-gnostr" 2>/dev/null
  pkill -f "scripts/[l]isten-chat" 2>/dev/null
  pkill -f "scripts/[c]hat-responder" 2>/dev/null
  echo stopped
}

do_status() {
  for s in supervisor listener observer responder; do
    if svc_alive "$s"; then
      echo "  $s: alive (pid $(cat "$(svc_pidfile "$s")"))"
    else
      echo "  $s: —"
    fi
  done
  echo "logs: $LOGDIR"
}

do_tail() {
  tail -n 50 -f "$LOGDIR"/listener.log "$LOGDIR"/chat-verbose.log "$LOGDIR"/responder.log 2>/dev/null
}

case "${1:-start}" in
  start)    do_start ;;
  stop)     do_stop ;;
  status)   do_status ;;
  tail)     do_tail ;;
  supervise) do_supervise ;;   # internal (the supervisor loop itself)
  *) echo "usage: $0 [start|stop|status|tail]" >&2; exit 2 ;;
esac
