FROM ghcr.io/dexidp/dex:v2.43.1@sha256:0881d3c9359b436d585b2061736ce271c100331e073be9178ef405ce5bf09557

USER 0:0
RUN addgroup -g 1001 khala-dex && adduser -D -u 1001 -G khala-dex khala-dex
COPY entrypoint.sh /usr/local/bin/khala-hosted-dex
RUN chmod 0755 /usr/local/bin/khala-hosted-dex
ENTRYPOINT ["/usr/local/bin/khala-hosted-dex"]
