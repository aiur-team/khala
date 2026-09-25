#!/usr/bin/env bash
# Throwaway proof driver: launches OpenCode in tmux with default settings (no
# --port) and types prompts into the TUI. Usage: drive.sh <command> [args]
# KHALA_PROOF_DIR must name a private 0700 scratch directory outside the repo.
set -uo pipefail
P=$(cd "$(dirname "$0")" && pwd)
S=${KHALA_PROOF_DIR:?set KHALA_PROOF_DIR to a private scratch directory}
export KHALA_PROOF_LOG=$S/events.jsonl
T=${KHALA_PROOF_TMUX:-khala-opencode-proof}
ts() { date -u +%FT%T.%3NZ; }
cmd=$1; shift
case $cmd in
  init)
    mkdir -p "$S"; chmod 700 "$S"; rm -f "${S:?}"/*
    touch "$S/events.jsonl"; chmod 600 "$S/events.jsonl"
    node "$P/queue.mjs" initialize "$S/state.json" "$P/fixtures/empty-state.json" </dev/null
    chmod 600 "$S/state.json" ;;
  launch)
    # Extra arguments are passed to opencode, e.g. --session <id>.
    LAUNCH="opencode --model deepseek/deepseek-flash $*"
    echo "{\"wall\":\"$(ts)\",\"type\":\"launch.command\",\"source\":\"driver\",\"cwd\":\"<probe>/workspace\",\"command\":\"$LAUNCH\",\"which\":\"$(command -v opencode)\",\"version\":\"$(opencode --version)\",\"env\":[\"KHALA_PROOF_STATE\",\"KHALA_PROOF_LOG\",\"KHALA_PROOF_IDLE_WATCH_MS=1000\"]}" >> "$S/events.jsonl"
    tmux new-session -d -s "$T" -x 180 -y 50 -c "$P/workspace" \
      -e KHALA_PROOF_STATE="$S/state.json" -e KHALA_PROOF_LOG="$S/events.jsonl" -e KHALA_PROOF_IDLE_WATCH_MS=1000 \
      "$LAUNCH"
    sleep "${WAIT:-10}" ;;
  type)
    # Types a prompt file into the TUI over the PTY; bytes never reach argv.
    echo "{\"wall\":\"$(ts)\",\"type\":\"driver.prompt.typed\",\"source\":\"driver\",\"prompt\":\"$(basename "$1")\"}" >> "$S/events.jsonl"
    tmux send-keys -t "$T" -l "$(cat "$1")"; sleep 0.5; tmux send-keys -t "$T" Enter ;;
  q) node "$P/queue.mjs" "$1" "$S/state.json" "${2:-}" </dev/null ;;
  enq) node "$P/queue.mjs" enqueue "$S/state.json" "$P/fixtures/$1.json" </dev/null ;;
  stop)
    tmux kill-session -t "$T"
    echo "{\"wall\":\"$(ts)\",\"type\":\"driver.process.stopped\",\"source\":\"driver\",\"how\":\"tmux kill-session (SIGHUP to the TUI)\"}" >> "$S/events.jsonl" ;;
  screen) tmux capture-pane -t "$T" -p | grep -v '^\s*$' | tail -"${1:-20}" ;;
  listen) ss -ltnp 2>/dev/null | grep -i opencode || echo "no opencode TCP listener" ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
