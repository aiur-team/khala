#!/usr/bin/env bash
# Usage: hooklog.sh <file-tag> <event-name>
# Appends one JSON record (tag, event, ts, filtered env, raw stdin) to the spike hook log.
tag="$1"; ev="$2"
stdin="$(cat)"
envs="$(env | grep -E '^(COPILOT|GITHUB_COPILOT|VSCODE|TERM_PROGRAM|CLAUDE|KHALA)' | grep -v -i token | sort | tr '\n' ';')"
ts="$(date +%s.%N)"
python3 -c 'import json,sys; print(json.dumps({"file":sys.argv[1],"event":sys.argv[2],"ts":sys.argv[3],"env":sys.argv[4],"stdin":sys.argv[5]}))' "$tag" "$ev" "$ts" "$envs" "$stdin" >> /tmp/claude-1000/spike-1114/logs/hooks.ndjson
echo '{}'
exit 0
