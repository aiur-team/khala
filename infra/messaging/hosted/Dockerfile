FROM ghcr.io/element-hq/synapse:v1.161.0@sha256:7155ddc4835e5b8afa4e1598d92aa16ff1d03109f7d1cff61d493237d1210b1d

COPY entrypoint.sh /usr/local/bin/khala-hosted-synapse
RUN chmod 0755 /usr/local/bin/khala-hosted-synapse
ENTRYPOINT ["/usr/local/bin/khala-hosted-synapse"]
