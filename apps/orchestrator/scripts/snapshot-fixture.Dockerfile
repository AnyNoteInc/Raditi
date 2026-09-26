# Verification-only tools image; not a P2 agent/sandbox product image.
FROM ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git zstd ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /agent-home \
    && chown 10001:10001 /workspace /agent-home
CMD ["sleep", "infinity"]
