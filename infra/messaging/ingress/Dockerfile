FROM caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/khala-ingress-entrypoint
RUN chmod 0755 /usr/local/bin/khala-ingress-entrypoint
ENTRYPOINT ["/usr/local/bin/khala-ingress-entrypoint"]
