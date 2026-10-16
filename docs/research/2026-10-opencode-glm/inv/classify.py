#!/usr/bin/env python3
"""Classifies every committed file that names Codex/Kimi/qwen/OpenAI/Moonshot (HEAD), plus the
files without such a name that the removal still touches. Read-only helper for the inventory."""
import os
import re
import subprocess
import sys
from collections import Counter

ROOT = subprocess.run(
    ['git', 'rev-parse', '--show-toplevel'],
    cwd=os.path.dirname(os.path.abspath(__file__)), capture_output=True, text=True, check=True,
).stdout.strip()
PATTERN = 'codex|kimi|qwen|moonshot|openai|chatgpt|gigacode'

D, R, T, G, H, O = 'delete', 'rewrite', 'keep-generic-touch', 'keep-generic', 'history', 'orphan-decide'

out = subprocess.run(
    ['git', 'grep', '-c', '-i', '-E', PATTERN, 'HEAD'], cwd=ROOT, capture_output=True, text=True
).stdout
hits = {}
for line in out.splitlines():
    _, path, count = line.split(':', 2)
    hits[path] = int(count)

# Files without a provider name that the removal still touches (verdict, note).
extra = {
    'packages/agent-drivers/src/fixtures/codex.jsonl': D,
    'packages/agent-drivers/src/fixtures/opencode.jsonl': R,
    'packages/agent-drivers/src/opencode.ts': R,
    'packages/agent-drivers/src/opencode-events.ts': R,
    'packages/llm-backends/src/kimi-code/fixtures/completed.sse': D,
    'packages/llm-backends/src/openai-chatgpt/fixtures/completed.sse': D,
    'apps/orchestrator/src/subscriptions/device-login.ts': R,
    'packages/domain/src/legal/documents.ts': R,
    'docs/model/Raditi_unit_economics.xlsx': R,
    '.github/workflows/llm-gateway.yml': T,
}

exact = {
    # root
    '.claude/agents/spec-reviewer.md': R,
    '.env.example': R,
    '.github/workflows/agent-content.yml': T,
    '.github/workflows/codex-driver.yml': R,
    'CLAUDE.md': R,
    'README.md': R,
    'package.json': R,
    'turbo.json': R,
    # orchestrator
    'apps/orchestrator/package.json': R,
    'apps/orchestrator/scripts/codex-runner-fixture.mjs': D,
    'apps/orchestrator/scripts/codex-runner-fixture.test.mjs': D,
    'apps/orchestrator/scripts/kimi-runner-fixture.mjs': D,
    'apps/orchestrator/scripts/kimi-runner-fixture.test.mjs': D,
    'apps/orchestrator/scripts/verify-codex-supervisor.mjs': D,
    'apps/orchestrator/scripts/verify-kimi-supervisor.mjs': D,
    'apps/orchestrator/scripts/verify-codex-supervisor.test.mjs': R,
    'apps/orchestrator/scripts/verify-agent-supervisor.mjs': R,
    'apps/orchestrator/scripts/verify-agent-content.mjs': R,
    'apps/orchestrator/scripts/verify-agent-content-turns.mjs': R,
    'apps/orchestrator/scripts/verify-llm-gateway.mjs': R,
    'apps/orchestrator/scripts/verify-llm-gateway-drivers.mjs': R,
    'apps/orchestrator/scripts/verify-llm-gateway-stream.mjs': R,
    'apps/orchestrator/scripts/verify-llm-lifecycle.mjs': R,
    'apps/orchestrator/scripts/verify-llm-protocol.mjs': R,
    'apps/orchestrator/scripts/verify-llm-crashes.mjs': R,
    'apps/orchestrator/scripts/verify-refresh-worker.mjs': O,
    'apps/orchestrator/scripts/verify-runner.mjs': R,
    'apps/orchestrator/scripts/verify-runner-core.mjs': R,
    'apps/orchestrator/src/drivers/drivers.module.ts': R,
    'apps/orchestrator/src/drivers/drivers-sandbox.module.test.ts': R,
    'apps/orchestrator/src/subscriptions/cli.ts': R,
    'apps/orchestrator/src/subscriptions/cli.test.ts': R,
    'apps/orchestrator/src/subscriptions/device-login.test.ts': R,
    'apps/orchestrator/src/subscriptions/device-login.network.test.ts': R,
    'apps/orchestrator/src/subscriptions/login.integration.test.ts': R,
    'apps/orchestrator/src/subscriptions/login.test.ts': R,
    'apps/orchestrator/src/subscriptions/retire.integration.test.ts': R,
    'apps/orchestrator/src/config/llm-config.test.ts': R,
    'apps/orchestrator/src/llm-gateway/credentials.test.ts': R,
    'apps/orchestrator/src/llm-gateway/egress.test.ts': R,
    'apps/orchestrator/src/llm-gateway/gateway.integration.test.ts': R,
    'apps/orchestrator/src/llm-gateway/pool-health.test.ts': R,
    'apps/orchestrator/src/llm-gateway/server.test.ts': R,
    'apps/orchestrator/src/llm-gateway/refresher.ts': O,
    'apps/orchestrator/src/llm-gateway/refresher.test.ts': O,
    'apps/orchestrator/src/llm-gateway/refresher.integration.test.ts': O,
    'apps/orchestrator/src/turns/turn-output.test.ts': R,
    'apps/orchestrator/src/turns/turn-result.test.ts': R,
    'apps/orchestrator/src/turns/turn-supervisor.test.ts': R,
    # web
    'apps/web/PRODUCT.md': R,
    'apps/web/src/components/landing/landing.tsx': R,
    # docs
    'docs/business.md': R,
    'docs/spec.md': R,
    'docs/plan/roadmap.md': R,
    'docs/landing/README.md': R,
    'docs/landing/landing.dc.html': R,
    # infra
    'infra/app/ci.test.mjs': R,
    'infra/app/llm-preflight.test.mjs': R,
    'infra/app/verify-llm-app.mjs': R,
    'infra/app/verify/compose.llm.yml': R,
    'infra/dev/db-verify/README.md': T,
    'infra/dev/gitea-verify/README.md': T,
    'infra/dev/site-verify/README.md': R,
    'infra/dev/site-verify/connect-local.test.mjs': T,
    'infra/dev/llm-verify/README.md': R,
    'infra/dev/llm-verify/agent-content.test.mjs': T,
    'infra/dev/llm-verify/backend-adapter.mjs': D,
    'infra/dev/llm-verify/backend-adapter.test.mjs': D,
    'infra/dev/llm-verify/certificates.mjs': R,
    'infra/dev/llm-verify/cli.Dockerfile': R,
    'infra/dev/llm-verify/cli.mjs': R,
    'infra/dev/llm-verify/cli.test.mjs': R,
    'infra/dev/llm-verify/compose.yml': R,
    'infra/dev/llm-verify/egress.mjs': R,
    'infra/dev/llm-verify/fake-subscriptions.mjs': R,
    'infra/dev/llm-verify/fake-subscriptions.test.mjs': R,
    'infra/dev/llm-verify/local-spike.mjs': D,
    'infra/dev/llm-verify/local-spike.test.mjs': D,
    'infra/dev/llm-verify/record-proxy.mjs': D,
    'infra/dev/llm-verify/record-proxy.test.mjs': D,
    'infra/egress/README.md': R,
    'infra/egress/env.example': R,
    'infra/egress/llm-egress.test.mjs': T,
    'infra/sandbox/Dockerfile': R,
    'infra/sandbox/compose.test.mjs': R,
    'infra/sandbox/gateway.mjs': R,
    'infra/sandbox/gateway.test.mjs': R,
    'infra/vault/verify-local.mjs': T,
    # packages
    'packages/agent-drivers/cli/README.md': R,
    'packages/agent-drivers/cli/package-lock.json': R,
    'packages/agent-drivers/cli/package.json': R,
    'packages/agent-drivers/package.json': R,
    'packages/agent-drivers/scripts/verify-codex.mjs': D,
    'packages/agent-drivers/src/cli-lock.test.ts': R,
    'packages/agent-drivers/src/cli-run.test.ts': R,
    'packages/agent-drivers/src/codex-events.ts': D,
    'packages/agent-drivers/src/codex-verifier.test.ts': D,
    'packages/agent-drivers/src/codex.test.ts': D,
    'packages/agent-drivers/src/codex.ts': D,
    'packages/agent-drivers/src/drivers.test.ts': R,
    'packages/agent-drivers/src/events.test.ts': R,
    'packages/agent-drivers/src/fixtures/README.md': R,
    'packages/agent-drivers/src/fixtures/kimi.jsonl': D,
    'packages/agent-drivers/src/fixtures/qwen.jsonl': D,
    'packages/agent-drivers/src/index.ts': R,
    'packages/agent-drivers/src/kimi-events.ts': D,
    'packages/agent-drivers/src/kimi.test.ts': D,
    'packages/agent-drivers/src/kimi.ts': D,
    'packages/agent-drivers/src/output-schema.ts': R,
    'packages/agent-drivers/src/prepared-run.test.ts': R,
    'packages/agent-drivers/src/qwen-events.ts': D,
    'packages/agent-drivers/src/qwen.ts': D,
    'packages/agent-drivers/src/registry.test.ts': R,
    'packages/agent-drivers/src/registry.ts': R,
    'packages/agent-drivers/src/session-paths.test.ts': R,
    'packages/agent-drivers/src/session-paths.ts': R,
    'packages/db/prisma/migrations/20260929130000_subscription_gateway/migration.sql': H,
    'packages/db/prisma/schema.prisma': R,
    'packages/db/prisma/seed/data.test.ts': R,
    'packages/db/prisma/seed/data.ts': R,
    'packages/domain/src/ports/agent-driver.ts': R,
    'packages/domain/src/ports/llm-backend.ts': R,
    'packages/domain/src/ports/llm-backend.test.ts': R,
    'packages/llm-backends/src/index.ts': R,
    'packages/llm-backends/src/stream.test.ts': R,
    'packages/sandbox-providers/src/gateway/gateway.integration.test.ts': R,
}

prefix = [
    ('apps/web/content/legal/', R),
    ('packages/llm-backends/src/kimi-code/', D),
    ('packages/llm-backends/src/openai-chatgpt/', D),
    ('docs/plan/', H),
    ('docs/research/', H),
]


def verdict(path):
    if path in exact:
        return exact[path]
    for start, value in prefix:
        if path.startswith(start):
            return value
    # Everything else that only names a driver or a backend in a fixture, a sample or a comment.
    return T


rows = []
for path, count in sorted(hits.items()):
    rows.append((path, count, verdict(path)))
for path, value in sorted(extra.items()):
    if path not in hits:
        rows.append((path, 0, value))

unknown = [path for path in exact if path not in hits]
if unknown:
    print('exact rules without a hit (check spelling):', unknown, file=sys.stderr)


def area(path):
    parts = path.split('/')
    if parts[0] in ('apps', 'packages', 'infra', 'docs') and len(parts) > 1:
        return '/'.join(parts[:2])
    return '(root)'


mode = sys.argv[1] if len(sys.argv) > 1 else 'summary'
if mode == 'tsv':
    for path, count, value in rows:
        print(f'{value}\t{count}\t{path}')
else:
    total = Counter(value for _, _, value in rows)
    print('files:', len(rows), '(with a name:', len(hits), ', extra:', len(rows) - len(hits), ')')
    for value, count in total.most_common():
        print(f'  {value:20} {count}')
    by_area = {}
    for path, _, value in rows:
        by_area.setdefault(area(path), Counter())[value] += 1
    for name in sorted(by_area):
        print(name, dict(by_area[name]))
