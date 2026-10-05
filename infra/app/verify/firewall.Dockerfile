# Built from an owned temporary context containing only llm-firewall.mjs and this file.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
RUN apt-get update \
    && apt-get install -y --no-install-recommends nftables iproute2 kmod procps python3 \
    && rm -rf /var/lib/apt/lists/*
COPY llm-firewall.mjs /llm-firewall.mjs
