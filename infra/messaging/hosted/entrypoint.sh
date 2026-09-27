#!/bin/sh
set -eu

# The provider injects this secret as a server-only variable. Decode it into
# ephemeral container storage before Synapse starts; neither value nor rendered
# config appears in argv, startup logs, image layers, or a committed file.
if [ "${KHALA_HOMESERVER_CONFIG_B64:-}" = "" ]; then
  echo 'missing-hosted-synapse-config' >&2
  exit 1
fi
if [ ! -d /data ]; then
  echo 'missing-synapse-data-volume' >&2
  exit 1
fi

umask 077
mkdir -p /config
chown 991:991 /config
chmod 0700 /config
if ! printf '%s' "$KHALA_HOMESERVER_CONFIG_B64" | base64 -d > /config/homeserver.yaml.tmp; then
  echo 'invalid-hosted-synapse-config' >&2
  exit 1
fi
unset KHALA_HOMESERVER_CONFIG_B64
if [ ! -s /config/homeserver.yaml.tmp ]; then
  echo 'empty-hosted-synapse-config' >&2
  exit 1
fi
chown 991:991 /config/homeserver.yaml.tmp /data
chmod 0400 /config/homeserver.yaml.tmp
mv /config/homeserver.yaml.tmp /config/homeserver.yaml

# The official /start.py uses gosu to execute the long-running process as
# UID/GID 991. /data, including its signing key, must be a persistent volume.
export SYNAPSE_CONFIG_PATH=/config/homeserver.yaml
export UID=991 GID=991
exec /start.py run
