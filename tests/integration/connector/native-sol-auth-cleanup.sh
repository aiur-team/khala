#!/bin/sh
# Remove only the disposable native proof's exact same-owner, mode-0600 auth copy.
set -eu
: "${KHALA_42_SYNC_ROOT:?}"
: "${CODEX_HOME:?}"
test "$CODEX_HOME" = "$KHALA_42_SYNC_ROOT/codex-home"
KHALA_42_AUTH_COPY="$CODEX_HOME/auth.json"
if test ! -e "$KHALA_42_AUTH_COPY" && test ! -L "$KHALA_42_AUTH_COPY"; then
  exit 0
fi
test -f "$KHALA_42_AUTH_COPY"
test ! -L "$KHALA_42_AUTH_COPY"
test "$(stat -c '%u:%a' "$KHALA_42_AUTH_COPY")" = "$(id -u):600"
test "$(realpath -e "$KHALA_42_AUTH_COPY")" = "$KHALA_42_AUTH_COPY"
/usr/bin/unlink "$KHALA_42_AUTH_COPY"
test ! -e "$KHALA_42_AUTH_COPY"
