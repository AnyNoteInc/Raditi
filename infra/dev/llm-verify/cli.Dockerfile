# Synthetic B13 verification only. The CLIs come from the production agent runtime
# (infra/sandbox/Dockerfile, target runtime: lockfile-built, the layout the drivers rely on);
# verify:llm-gateway builds it first as raditi-p3verify-runtime:b13. This image only adds the
# harness entry point and the working-copy mount points.
ARG RUNTIME_IMAGE=raditi-p3verify-runtime:b13
FROM ${RUNTIME_IMAGE}
USER root
# The build fails unless the runtime holds exactly the CLI versions the harness verifies.
RUN cd /usr/local/lib/raditi/agent-clis \
    && npm ls @openai/codex@0.158.0 \
    && npm ls @moonshot-ai/kimi-code@2.1.1 \
    && mkdir -p /workspace/repo /workspace/inbox \
    && chown 10001:10001 /workspace/repo /workspace/inbox
COPY cli.mjs /usr/local/lib/raditi/cli.mjs
USER 10001:10001
WORKDIR /workspace/repo
