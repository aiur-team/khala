#!/bin/sh
set -eu

if [ "${KHALA_DEX_CONFIG_B64:-}" = "" ]; then
  echo 'missing-hosted-dex-config' >&2
  exit 1
fi
if [ ! -d /data ]; then
  echo 'missing-dex-data-volume' >&2
  exit 1
fi

umask 077
mkdir -p /etc/dex/khala
chown 1001:1001 /etc/dex/khala /data
chmod 0700 /etc/dex/khala
if ! printf '%s' "$KHALA_DEX_CONFIG_B64" | base64 -d > /etc/dex/khala/config.yaml.tmp; then
  echo 'invalid-hosted-dex-config' >&2
  exit 1
fi
unset KHALA_DEX_CONFIG_B64
if [ ! -s /etc/dex/khala/config.yaml.tmp ]; then
  echo 'empty-hosted-dex-config' >&2
  exit 1
fi
chown 1001:1001 /etc/dex/khala/config.yaml.tmp
chmod 0400 /etc/dex/khala/config.yaml.tmp
mv /etc/dex/khala/config.yaml.tmp /etc/dex/khala/config.yaml
exec su -p -s /bin/sh khala-dex -c 'exec dex serve /etc/dex/khala/config.yaml'
