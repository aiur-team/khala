#!/bin/sh
# Spike U28: record the MCP child's environment and JSON-RPC traffic, then run `khala mcp`.
L=/tmp/claude-1000/spike-1115/logs
mkdir -p "$L"
{ echo "pid=$$ ppid=$PPID cwd=$(pwd) args=$*"; env | sort; } > "$L/mcp-env-$$.txt"
tee -a "$L/mcp-in-$$.jsonl" | khala mcp | tee -a "$L/mcp-out-$$.jsonl"
