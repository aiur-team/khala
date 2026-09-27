#!/bin/sh
set -eu

# Never print the values: Caddy expands them internally from the environment.
if [ "${KHALA_REGISTRATION_INGRESS_TOKEN:-}" = "" ] || [ "${#KHALA_REGISTRATION_INGRESS_TOKEN}" -lt 32 ]; then
  echo 'missing-or-weak-registration-ingress-token' >&2
  exit 1
fi
if [ "${KHALA_SYNAPSE_UPSTREAM:-}" = "" ]; then
  echo 'missing-synapse-upstream' >&2
  exit 1
fi
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
