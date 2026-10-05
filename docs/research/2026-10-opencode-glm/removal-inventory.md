# Removal inventory — Codex, Kimi, qwen and the OpenAI/Moonshot subscriptions

Reader's pass only: nothing in the repository was changed. Baseline — the committed state of branch
`codex/p3-llm-gateway`, `HEAD = c9be168` (read with `git show HEAD:<path>` and `git grep … HEAD`).
The working tree is edited by other sessions (billing, landing, a site page); where it differs from
`HEAD` in a place that matters, it is said explicitly.

Search: `git grep -n -i -E 'codex|kimi|qwen|moonshot|openai|chatgpt|gigacode' HEAD` — **256 files**
carry one of the names (4 153 matching lines). Plus **10 files** without such a name that the removal still
touches (fixtures, the OpenCode stub, the legal registry, the workbook). Helper and its per-file
output (same directory): `inv/classify.py`, `inv/classified.tsv`, `inv/hits-by-file.txt`.

Verdicts used below:

- **delete** — exists only for Codex, Kimi, qwen or their subscriptions;
- **rewrite** — the file stays, its content is re-pointed to OpenCode and Z.ai (GLM Coding Plan);
- **keep: generic** — provider-neutral code. With «touch» — it names `codex`/`kimi`/`openai-chatgpt`
  only as a sample id, a sample Vault path or a comment; the rename is mechanical, the logic stays;
- **keep as history** — reports, research, applied migrations: never edited;
- **decide** — generic by form (written against a port), but its only implementer is Codex. Deleting
  it is a design decision, not a clean-up (section 3).

## 1. Counts

| Verdict | Files | Note |
| --- | ---: | --- |
| delete | 49 | 12 858 lines at `HEAD` |
| rewrite for OpenCode and Z.ai | 101 | of them 32 in `apps/orchestrator`, 20 in `infra`, 19 in `packages/agent-drivers` |
| keep: generic, touch (ids, sample paths, comments) | 64 | 41 in `apps/orchestrator` (tests and two shared fixtures) |
| keep as history | 48 | 34 reports `docs/plan/00–36`, 13 research files, 1 applied migration |
| decide (orphaned OAuth machinery) | 4 | `refresher.ts` + 2 tests + `verify-refresh-worker.mjs`; more in section 3 |
| **Total classified** | **266** | 256 with a name + 10 without |

By area (delete / rewrite / touch / history / decide):

| Area | delete | rewrite | touch | history | decide |
| --- | ---: | ---: | ---: | ---: | ---: |
| `packages/agent-drivers` | 13 | 19 | – | – | – |
| `packages/llm-backends` | 24 | 2 | – | – | – |
| `packages/domain` | – | 4 | 9 | – | – |
| `packages/db` | – | 3 | 3 | 1 | – |
| `packages/sandbox-providers`, `packages/vault` | – | 1 | 3 | – | – |
| `apps/orchestrator` (src + scripts + package.json) | 6 | 32 | 41 | – | 4 |
| `apps/web` | – | 7 | – | – | – |
| `infra/sandbox`, `infra/egress`, `infra/app`, `infra/vault` | – | 10 | 2 | – | – |
| `infra/dev` | 6 | 10 | 4 | – | – |
| root (`CLAUDE.md`, `README.md`, `package.json`, `turbo.json`, `.env.example`, `.github`, `.claude`) | – | 7 | 2 | – | – |
| `docs` | – | 6 | – | 47 | – |

Everything not listed in sections 2–3 has no provider name and no provider-shaped logic: it is
generic and stays untouched (section 4 names the modules that look subscription-specific but are not).

## 2. Inventory by area

### 2.1 `packages/agent-drivers`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `src/codex.ts` (173), `src/codex-events.ts` (95), `src/codex.test.ts` (324) | Codex driver: `prepare`/`command`, JSONL parser, tests | delete | Codex only |
| `src/kimi.ts` (222), `src/kimi-events.ts` (44), `src/kimi.test.ts` (387) | Kimi driver | delete | Kimi only |
| `src/qwen.ts` (40), `src/qwen-events.ts` (61) | qwen stub (P1, `prepare`/`command` throw `NOT_IMPLEMENTED`) | delete | never in the product |
| `src/fixtures/codex.jsonl`, `kimi.jsonl`, `qwen.jsonl` | parser fixtures | delete | their parsers go |
| `scripts/verify-codex.mjs` (649), `src/codex-verifier.test.ts` (97) | stand `pnpm verify:codex` and the test of its Docker guard | delete | replaced by an OpenCode stand (section 7) |
| `src/opencode.ts` (45), `src/opencode-events.ts` (66), `src/fixtures/opencode.jsonl` | OpenCode: parser + session files; `prepare`/`command` throw `opencode.<method> (P5)` (`opencode.ts:23,31-36`) | rewrite | becomes the only driver; header comment says «a fallback … verified in P5», pinned to 1.18/1.18.32 |
| `src/registry.ts`, `src/index.ts` | four drivers and four parsers registered (`registry.ts:22-36`) | rewrite | one driver left |
| `src/session-paths.ts` | `requireNativeSessionId`, `KIMI_WORKDIR_KEY`, `QWEN_PROJECT_KEY` | rewrite | the two constants go; `requireNativeSessionId` is used only by kimi and qwen — keep only if the OpenCode driver needs it |
| `src/output-schema.ts` | `RESULT_SIZE_NOTE` (codex, kimi) and `strictOutputSchema` (codex `--output-schema` only, `output-schema.ts:94-106`) | rewrite | `strictOutputSchema` loses its only caller unless OpenCode gets a schema (its capability `outputSchema` is `false`) |
| `src/cli-run.ts` | per-turn plumbing: secret files `llm`/`mcp`, `runContextSchema(effort)`, attachments, staging | keep: generic | provider-neutral; the OpenCode driver should reuse it |
| `src/config.ts`, `src/jsonl.ts` (+ `config.test.ts`, `output-schema.test.ts`) | image config, JSONL helpers, result extraction | keep: generic | no provider name |
| `src/cli-run.test.ts`, `drivers.test.ts`, `events.test.ts` (49 hits), `prepared-run.test.ts`, `registry.test.ts`, `session-paths.test.ts`, `cli-lock.test.ts` | shared tests parameterised over codex, kimi, qwen, opencode | rewrite | keep the OpenCode cases, drop the rest, re-point the common cases |
| `src/fixtures/README.md` | sources of the four JSONL formats | rewrite | keep the OpenCode row, update the version |
| `cli/package.json`, `cli/package-lock.json` (698), `cli/README.md` | lockfile of the CLIs installed into the sandbox image: `@moonshot-ai/kimi-code` 2.1.1, `@openai/codex` 0.158.0 | rewrite | pin `opencode-ai` (owner allowed 1.18.34 and its platform binary); the README names `verify:codex`, `verify:kimi-supervisor` |
| `package.json` | script `verify:codex` (line 14) | rewrite | new stand name |

### 2.2 `packages/llm-backends`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `src/openai-chatgpt/` — `auth.ts`, `backend.ts`, `credentials.ts`, `egress.ts`, `login.ts`, `policy.ts`, `responses.ts`, `stream.ts`, `usage.ts`, 5 tests, `fixtures/auth.ts`, `fixtures/completed.sse` (16 files) | Codex adapter: Responses body policy, SSE meter, device login, OAuth refresh/revoke, `x-codex-*` windows | delete | Codex only. Before deleting: `policy.ts`/`usage.ts`/`stream.ts` are the nearest template if OpenCode is pointed at the Responses endpoint `https://api.z.ai/api/v1` |
| `src/kimi-code/` — `backend.ts`, `body.ts`, `errors.ts`, `stream.ts`, `usage.ts`, 2 tests, `fixtures/completed.sse` (8 files) | Kimi adapter: API key via `importCredential`, chat/completions body policy, usage in the last chunk, windows by probe | delete | Kimi only. Before deleting: it is the nearest template for a key-based chat/completions backend (`/api/coding/paas/v4/chat/completions`) |
| `src/index.ts` | `llmBackends = [codexBackend, kimiCodeBackend]` (line 8) | rewrite | the list every consumer derives from: egress config, role `llm`, CLI |
| `src/stream.test.ts` (52 hits) | tests of both stream inspectors | rewrite | new adapter's inspector |
| `src/shared.ts`, `sse.ts`, `usage.ts`, `stream-errors.ts`, `data-url.ts` (+ tests) | control request with deadline, SSE decoder, meter helpers, safe stream error, inline image check | keep: generic | no provider name; used by both adapters |

### 2.3 `packages/domain`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `src/ports/agent-driver.ts:15` | `agentDriverIds = ['codex', 'kimi', 'qwen', 'opencode']`; comments at lines 13 and 30 | rewrite | ids shrink to `opencode`; removed ids must be refused by the runner protocol and the snapshot manifest, as `gigacode` and `sourcecraft` are (`runner/protocol.test.ts:128`, `sessions/snapshot-manifest.test.ts:42`) |
| `src/ports/llm-backend.ts:4` | `llmBackendIds = ['openai-chatgpt', 'kimi-code']` | rewrite | new slug; old slugs go last (section 5) |
| `src/ports/llm-backend.ts:219-403` | port `LlmBackend`: optional `refresh`, `login: DeviceLogin`, `revoke`, `importCredential`; `ClientIdentity`; `creditsBalance` | keep: generic + decide | the port is neutral; `refresh`, `login`, `revoke`, `DeviceLogin*`, `RefreshOutcome`, `installationId`/`deviceId`/`deviceName`, `creditsBalance` have no implementer after the pivot (section 3) |
| `src/ports/llm-backend.test.ts:397-399` | id enum test | rewrite | new id, old ones join the refused list |
| `src/legal/documents.ts:30,37,44,51` | editions `2026-09-29` of the four required documents | rewrite | new editions → users accept again (section 6) |
| `src/llm/*` (`budget`, `cost`, `json-policy`, `model-class`, `money`, `pool`), `src/ports/turn-*.ts`, `src/runner/protocol.ts`, `src/sessions/*` | budgets, cost, pool selection, turn plan, runner protocol | keep: generic | consume the id enums, name no provider |
| `src/ports/sandbox-provider.ts:223` | comment «OpenAI-style keys» over the `sk-…` heuristic | keep: generic, touch | the heuristic stays; a Z.ai key is `<id>.<secret>`, not `sk-…` — the name rule (`KEY`, `TOKEN`…) still catches `ZAI_API_KEY` |
| tests: `llm/cost.test.ts` (17), `llm/pool.test.ts` (7), `ports/agent-driver.test.ts` (6), `ports/sandbox-provider.test.ts` (6), `ports/turn-credential-grant.test.ts` (2), `ports/turn-executor.test.ts` (16), `runner/protocol.test.ts` (11), `sessions/snapshot-manifest.test.ts` (4) | sample ids, sample env names, `historicalKimiPrices`/`historicalQwenPrices` | keep: generic, touch | rename ids; add `codex`, `kimi`, `qwen` to the «refuses a removed driver» cases |

### 2.4 `packages/db`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `prisma/seed/data.ts:154-179` | `agent_drivers`: codex and kimi `enabled: true`, qwen and opencode `false` | rewrite | only `opencode`; note `apply.ts:7-8,92-104`: `enabled` and `image` are set **on create only**, an existing row is never re-enabled by a seed |
| `prisma/seed/data.ts:191-247` | providers `openai-chatgpt`, `kimi-code`; models `gpt-6-luna-light`, `gpt-6-sol-standard`, `gpt-6-sol-heavy`, `k3-256k-standard` — all disabled, no prices | rewrite | new provider and GLM profiles (`glm-5.3`, `glm-5.3-flash`, `glm-5-turbo` are what the probe saw); rates stay unseeded |
| `prisma/seed/data.test.ts` (12 hits) | seed expectations | rewrite | — |
| `prisma/schema.prisma:567,908,1004` | three comments (Codex thread id, «Codex defaults to 32000; Kimi … 32768», «codex or kimi») | rewrite | comments only; no enum, no column and no CHECK names a provider |
| `prisma/migrations/20260929130000_subscription_gateway/migration.sql:20,35` | comments `chatgpt_account_id`, `x-codex-credits-*` | keep as history | applied migration |
| `prisma/constraints.test.ts:332`, `src/task-turn-assignments.test.ts`, `src/turn-assignments.test.ts` | sample route `/codex/responses`, driver row `codex` | keep: generic, touch | rename |
| all 18 migrations, `seed/apply.ts`, `src/*` | schema v1, gateway tables, seeding rules | keep: generic / history | `agent_drivers.id` and `llm_providers.slug` are `VARCHAR`, not enums |

**What the NEW migration must do** (precedent — `20260929120000_subscriptions_expand`, which
disabled API providers and kept price history):

1. `UPDATE "agent_drivers" SET "enabled" = false WHERE "id" IN ('codex', 'kimi', 'qwen')`. No
   `DELETE`: `task_turns`, `token_usage`, `llm_keys`, `subscription_accounts`,
   `task_account_bindings`, `chat_sessions` reference the row with `ON DELETE RESTRICT`.
2. `UPDATE "llm_providers" SET "enabled" = false WHERE "slug" IN ('openai-chatgpt', 'kimi-code')` and
   the same for their `llm_models`. Rows, `llm_model_prices`, `token_usage`, `llm_calls` stay as
   history (`llm_models.provider_id` and price rows are `RESTRICT`).
3. `subscription_accounts` of the two providers: `enabled = false`. The CHECK
   `subscription_accounts_retired_check` only requires «retired ⇒ not enabled», so a plain disable is
   legal; a real account must first go through `subscriptions:retire` while its adapter still exists
   (section 5, step 4).
4. Enable the replacement on existing databases: `UPDATE "agent_drivers" SET "enabled" = true WHERE
   "id" = 'opencode'` — the seed will not do it (create-only), and the row already exists disabled
   wherever seeds ran. The new provider and models are created by the seed, disabled, as today.
5. Nothing else is required: no enum value, CHECK or index names a provider. Optional, as a later
   contract migration: columns that only Codex or Kimi fed — `subscription_accounts.credits_seen`,
   `external_account_id`, `client_identity`, `credential_expires_at`, `credential_refreshed_at`,
   `refresh_started_at`, `refresh_finished_at`, `refresh_failures` (section 3). The legacy
   `task_turns.litellm_key_hash`, `subscription_accounts.limits` and the `service` model class are
   an older debt («P4 contract migration» in `schema.prisma:571,1011`), unrelated to this pivot.
6. `cross_border_clearances` rows are per provider (`provider_id`): a clearance for OpenAI or
   Moonshot does not cover Z.ai. `issue` keeps refusing `client` data for the new provider until a
   new row exists (`apps/orchestrator/src/llm/turn-credentials.ts:403-410`) — the gate works unchanged.

### 2.5 `packages/sandbox-providers`, `packages/vault`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `packages/sandbox-providers/src/gateway/gateway.integration.test.ts` (30 hits) | real-daemon test of `sandbox-gw`: routes `/codex/responses`, `/kimi/v1/chat/completions`, `x-codex-*` headers | rewrite | follows `infra/sandbox/gateway.mjs` |
| `packages/sandbox-providers/src/**` (the rest), `runtime/runtime.mjs` | Docker provider, launch wrapper | keep: generic | routes are groups `llm`/`mcp`, no provider path |
| `packages/vault/src/kv.test.ts` (28), `kv-limits.test.ts` (2), `vault-secret-store.test.ts` (3) | sample paths `subs/openai-chatgpt/account_1`, `subs/kimi-code/…` | keep: generic, touch | the client does not validate the backend segment |

### 2.6 `apps/orchestrator/src`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `drivers/drivers.module.ts:9`, `drivers/drivers-sandbox.module.test.ts:24-25` | `ENABLED_AGENT_DRIVERS = ['codex', 'kimi']`; the test expects `drivers.get('opencode')` to throw `NOT_FOUND` | rewrite | `['opencode']`; the expectation flips |
| `subscriptions/cli.ts:13,158-179,184` | import table of backends: `codexBackend` (driver `codex`, 1 turn, 2 requests, device page `https://auth.openai.com/codex/device`), `kimiCodeBackend` (driver `kimi`, 2 turns, 3 requests); help text «Kimi: ключ… Codex: код…» | rewrite | one key-import entry; concurrency per account is a new number to choose |
| `subscriptions/device-login.ts` | `authenticateSubscription`: key import branch (lines 43-51) and device flow (52+), revoke of an unsaved login | rewrite | the import branch stays; the device-flow branch — section 3 |
| `subscriptions/login.ts`, `retire.ts`, `secret-input.ts` | import/relogin under the lock, retirement stages, hidden input | keep: generic | written against the port; `console_revocation_required` is the key-based path Z.ai will use |
| `llm-gateway/server.ts`, `store.ts`, `pool-health.ts`, `pool-health-store.ts`, `credentials.ts`, `egress.ts`, `egress-probe.ts`, `session-lock.ts`, `types.ts`, `llm-app.module.ts` | role `llm`: routes from `backend.routes`, budget, slots, metering, pool health, mTLS CONNECT | keep: generic | `server.ts:42` is a comment («The pinned Codex CLI gives a silent stream the same five minutes») over `upstreamIdleMs: 300_000` — re-check the number against OpenCode |
| `llm-gateway/refresher.ts` (756) + `refresher.test.ts` (1 004) + `refresher.integration.test.ts` (356) | OAuth single writer: scheduled refresh, 401 refresh, provider revoke on retirement | decide | only Codex implements `refresh`/`revoke` (section 3) |
| `llm/turn-credentials.ts`, `credential-sweeper.ts`, `pool-probe-client.ts`, `turn-key.ts`, `llm.module.ts` | turn keys in `core` | keep: generic | pool query filters by provider and driver (`turn-credentials.ts:450-451`), stale rows of removed providers are never read |
| `config/llm-config.ts` | egress config and override variables derived from `llmBackends[].egress` | keep: generic | variable names come from the adapters (`overrideEnv`) |
| `mcp/mcp-auth.guard.ts:61`, `turns/turn-output.ts:33` | comments naming Codex | keep: generic, touch | behaviour is neutral |
| `testing/runner-sandbox.ts:34,37,139,158`, `testing/turn-credentials.ts:38-39` | shared test fixtures: image `…/raditi/codex@sha256`, home `/agent-home/codex`, `driverId: 'codex'`, `backend: 'openai-chatgpt'` | keep: generic, touch | every test below inherits these ids |
| tests on the real adapters or drivers: `config/llm-config.test.ts`, `llm-gateway/{credentials,egress,pool-health,server,gateway.integration}.test.ts`, `subscriptions/{device-login,device-login.network,login,login.integration,retire.integration}.test.ts`, `turns/{turn-output,turn-result,turn-supervisor}.test.ts` (14 files import them; the two `refresher` tests do too and are under «decide»), plus `subscriptions/cli.test.ts`, which follows `cli.ts` | tests of generic code driven through `codexBackend`, `kimiCodeBackend`, `createCodexDriver`, `createKimiDriver` | rewrite | must be re-pointed **before** the adapters are deleted |
| tests with ids only (31 files: `config`, `core`, `drivers`, `llm`, `llm-gateway` stores, `mcp`, `runner`, `runner-api`, `sessions`, `turns`, `subscriptions/{retire,secret-input}`) | sample `driverId`, `backendId`, home paths | keep: generic, touch | list — `inv/classified.tsv`, rows `keep-generic-touch` |

### 2.7 `apps/orchestrator/scripts` and `package.json`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `codex-runner-fixture.mjs` (+ test), `kimi-runner-fixture.mjs` (+ test) | synthetic provider + MCP for the supervisor stands | delete | replaced by an OpenCode/Z.ai fixture |
| `verify-codex-supervisor.mjs`, `verify-kimi-supervisor.mjs` | 25-line launchers of `verify-agent-supervisor.mjs` | delete | one launcher for OpenCode |
| `verify-agent-supervisor.mjs:407-416`, `verify-codex-supervisor.test.mjs` (359) | generic harness (disposable services, runner in the Linux VM); accepts `codex`/`kimi`; the test file checks the harness guards under the Codex name | rewrite | driver switch and milestone labels `P4`/`P5` |
| `verify-runner.mjs` (36 hits), `verify-runner-core.mjs` (11) | gates 2–3 of P2, seven scenarios; the synthetic agent prints Codex JSONL and uses the Codex driver's parser and session state; `--codex`/`--kimi` run the real CLI | rewrite | the synthetic agent must speak OpenCode's events and session files, or a neutral test driver |
| `verify-llm-gateway.mjs` (72), `-drivers.mjs` (72), `-stream.mjs` (49), `verify-llm-lifecycle.mjs` (100), `verify-llm-protocol.mjs` (50), `verify-llm-crashes.mjs` (26) | stand B13 `pnpm verify:llm-gateway` | rewrite | section 7; the token-rotation crash scenarios of `verify-llm-crashes.mjs` lose their subject |
| `verify-refresh-worker.mjs` | IPC worker with fault barriers around `SubscriptionRefresher` | decide | follows `refresher.ts` |
| `verify-agent-content.mjs` (19), `verify-agent-content-turns.mjs` (20) | stand N2 `pnpm verify:agent-content` | rewrite | section 7 |
| `verify-content-turns.mjs` (9), `verify-content-undo.mjs`, `verify-content-worker.mjs`, `verify-snapshot-transport.mjs`, `verify-snapshots.mjs` | content and snapshot stands with a `codex` driver row or home path | keep: generic, touch | ids only |
| `verify-llm-worker.mjs`, `verify-core-worker.mjs`, `verify-agent-content-role.mjs`, `verify-publication.mjs`, `verify-content-lifecycle.mjs`, `runner-token.mjs`, `subscription-*.mjs` | isolated roles, publication, operator entry points | keep: generic | no provider name |
| `package.json:19,25` | scripts `verify:codex-supervisor`, `verify:kimi-supervisor` | rewrite | — |

### 2.8 `infra/sandbox`, `infra/egress`, `infra/app`, `infra/vault`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `infra/sandbox/Dockerfile:1,9-29` | stage `runtime`: `npm ci` of the CLI lockfile, `npm ls @openai/codex@0.158.0`, `npm ls @moonshot-ai/kimi-code@2.1.1`, symlinks `codex`, `kimi` | rewrite | install `opencode-ai`; `npm ci --ignore-scripts` must still deliver its platform binary (unknown, section 9) |
| `infra/sandbox/gateway.mjs:10-20,27,68,221-232` | `sandbox-gw`: LLM request headers (`x-openai-subagent`, `x-codex-turn-state`, `x-openai-internal-codex-responses-lite`), response header `x-codex-turn-state`, routes `/codex/responses` and `/kimi/v1/chat/completions`, `x-msh-*` limits | rewrite | the route list is a literal here, not derived from the adapters: a new route is added in both places |
| `infra/sandbox/gateway.test.mjs` (41), `compose.test.mjs:49` | tests of the above; the Dockerfile contract names both npm packages | rewrite | — |
| `infra/sandbox/{docker-compose.yml,watchdog.mjs,network-guard.mjs,host-firewall.mjs}` | sandbox VM services | keep: generic | — |
| `infra/egress/README.md:3,36,180-183,212,224`, `env.example:4-5` | runbook; `LLM_EGRESS_ALLOW=chatgpt.com:443,auth.openai.com:443,api.kimi.ai:443`; the country is chosen «из списка стран ChatGPT» | rewrite | allow `api.z.ai:443`; whether the node is needed at all is open (section 9) |
| `infra/egress/llm-egress.mjs`, `make-ca.sh`, `nftables.conf`, `raditi-egress.service` | CONNECT proxy with mTLS, allowlist from the environment | keep: generic | no host is hardcoded |
| `infra/egress/llm-egress.test.mjs` (38) | sample hosts in proxy tests | keep: generic, touch | — |
| `infra/app/verify/compose.llm.yml:49` | the stand's `LLM_EGRESS_ALLOW` | rewrite | — |
| `infra/app/verify-llm-app.mjs:344-345,592,610` | forbidden overrides `LLM_BACKEND_URL_OPENAI_CHATGPT`, `LLM_BACKEND_URL_KIMI_CODE`; probes `POST /codex/responses` | rewrite | new variable name and route |
| `infra/app/llm-preflight.test.mjs:254-256` | the three override names refused in production | rewrite | — |
| `infra/app/ci.test.mjs:233-235` | CI contract pins the file name `codex-driver.yml` and its job `sandbox-isolation` | rewrite | follows the workflow rename |
| `infra/app/{docker-compose.yml,llm-firewall.mjs,llm-preflight.mjs,env.example,secrets.example/llm/*,systemd/*,README.md}` | app-VM profile `llm`, early firewall, preflight | keep: generic | no provider name; the profile assumes outbound only to `EGRESS_PROXY_IP` |
| `infra/vault/policies/{llm-subscriptions,subscriptions-writer,subscriptions-admin}.hcl`, `bootstrap.mjs` | `subs/data/*`, `subs/metadata/*`, `subs/destroy/*` | keep: generic | path is `subs/<backend>/<accountId>`, no backend in a policy |
| `infra/vault/verify-local.mjs:231,238,255,387,890,1053` | sample paths `subs/openai-chatgpt/…`, `subs/kimi-code/…` | keep: generic, touch | — |

### 2.9 `infra/dev`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `llm-verify/record-proxy.mjs` (828) + test (1 531) | recording pass of the P3.0 spike for Codex and Kimi (`ORIGINS`, `RECORD_CODEX_AUTH`) | delete | the spike of the old providers; a recorder for Z.ai, if wanted, is a new short tool |
| `llm-verify/local-spike.mjs` (695) + test (526) | live check on the owner's Codex subscription (reads the existing login through `record-proxy`) | delete | the rule-1 exception of 29.09.2026 dies with Codex |
| `llm-verify/backend-adapter.mjs` (166) + test (326) | drives `codexBackend` against `chatgpt.com` for the live check | delete | same |
| `llm-verify/fake-subscriptions.mjs` (1 176) + test (1 007) | fake ChatGPT backend, fake OpenAI auth (device flow, token rotation), fake Kimi, synthetic MCP; scenarios | rewrite | a fake Z.ai: errors as HTTP 200 with `{code: 401 | 1001 | 500}`, `reasoning_content`, the quota answer; OAuth endpoints go |
| `llm-verify/cli.mjs` (502) + test (374), `cli.Dockerfile` | CLI containers of B13: hand-written Codex/Kimi configs, `CLI_VERSIONS`, `npm ls` of both | rewrite | OpenCode config and version |
| `llm-verify/certificates.mjs`, `egress.mjs`, `compose.yml` | stand TLS (SAN `chatgpt.com`, `auth.openai.com`, `api.kimi.ai`), test proxy allow set | rewrite | host names |
| `llm-verify/README.md` (232, 70 hits) | how B13 runs the CLIs + the P3.0 recording runbook | rewrite | the P3.0 half goes with its tools |
| `llm-verify/stack.mjs`, `workers.mjs` (+ tests), `agent-content.test.mjs` | disposable stack, role workers, CI contract of the content stand | keep: generic (one comment to touch) | — |
| `site-verify/README.md:43,47` | «Настоящие CLI (Codex 0.158.0 и Kimi 2.1.1 …)» | rewrite | — |
| `site-verify/connect-local.test.mjs:827`, `db-verify/README.md:23`, `gitea-verify/README.md:24` | sample Vault path, the `codex` driver row, `pnpm verify:codex-supervisor` | keep: generic, touch | — |

### 2.10 `.github`, root scripts, environment

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `.github/workflows/codex-driver.yml` | job `verify-codex` (`pnpm verify:codex`) and job `sandbox-isolation` (provider suites on a real daemon) | rewrite | rename; **`sandbox-isolation` is generic and must survive** (`infra/app/ci.test.mjs:232-250` checks it by the file name) |
| `.github/workflows/agent-content.yml:3`, `llm-gateway.yml:3,50` | comments «Codex and Kimi CLIs», «two CLI distributions» | keep: generic, touch | steps run `pnpm verify:agent-content`, `pnpm verify:llm-gateway` |
| `.github/workflows/{ci,llm-app,edge,edge-cert,wordpress-content,release}.yml` | gates, app stands, releases | keep: generic | — |
| `package.json:39,40,42` | `verify:codex`, `verify:codex-supervisor`, `verify:kimi-supervisor` | rewrite | — |
| `.env.example:43-45` | `LLM_BACKEND_URL_OPENAI_CHATGPT`, `LLM_AUTH_URL_OPENAI`, `LLM_BACKEND_URL_KIMI_CODE` | rewrite | one override of the new adapter; `scripts/check-env.mjs` requires every `.env.example` name in `turbo.json` |
| `turbo.json:18-20` | the same three names in `globalEnv` | rewrite | — |
| `.env.example` — the rest (`LLM_GATEWAY_*`, `LLM_EGRESS_*`, `LLM_CONTROL_URL`, `LLM_POOL_MIN_TURN_HEADROOM_PCT`, `SANDBOX_*`) | gateway, egress, sandbox | keep: generic | — |
| `.claude/agents/spec-reviewer.md:13` | reviewer rule naming «OpenAI через подписки ChatGPT, Moonshot через Kimi Code» | rewrite | — |

No `ZAI_*` variable exists in `.env.example` or `turbo.json` (neither at `HEAD` nor in the working tree).

### 2.11 `apps/web`

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `content/legal/consent.md`, `privacy-policy.md`, `public-offer.md`, `user-agreement.md` | legal texts naming the recipients | rewrite | section 6, with new editions |
| `content/legal/README.md` (14 hits) | notes for the lawyer: «Трансграничная передача в OpenAI и Moonshot» | rewrite | section 6 |
| `src/components/landing/landing.tsx:85` | FAQ answer naming OpenAI and Moonshot | rewrite | section 6 |
| `PRODUCT.md:28` | product note for the landing | rewrite | — |
| everything else in `apps/web` | — | keep: generic | no model or recipient is named anywhere else in `apps/web/src`, `packages/ui`, `packages/mail`, `packages/notifications` |

### 2.12 `docs`, `CLAUDE.md`, `README.md`

`docs/spec.md` (166 lines with a name, 1 840 lines), by section:

| Section | Lines with a name | What must change | Verdict |
| --- | ---: | --- | --- |
| header, §1 «Коротко» (L5–69) | 9 | summary table, decisions 1, 2, 7, 8, «что не берём» | rewrite |
| §3 «Границы MVP» (L107–108) | 2 | agents and models rows | rewrite |
| §5 «Архитектура» (L143–187) | 6 | diagram nodes, `sandbox-gw` paths, `egress-1` hosts, providers row | rewrite |
| §6 «Монорепозиторий» (L225–226) | 2 | `agent-drivers`, `llm-backends` rows | rewrite |
| §8 «Агентный рантайм» (L314–459) | 14 | driver id list (L320), the table of four CLIs (L345–348), `command` notes, sandbox paths and routes (L432) | rewrite |
| §9 «Агенты и подписки» (L620–877) | 66 | the whole section: backends table, profiles, routes and headers, CLI retry tables, body policy of both shells, pool, windows, credits, provider signals, egress hosts, «Оболочки в песочнице» configs | rewrite (largest piece) |
| §11 (L1007) | 1 | «Модели работают за рубежом» | rewrite |
| §15 «Vault» (L1128–1177) | 8 | `subs/` content, login, relogin, Codex token refresh, Kimi key | rewrite |
| §16 (L1217) | 1 | `llm_providers` slugs | rewrite |
| §17 «Тарифы и оплата» (L1300–1329) | 5 | accounting rates formula for Codex credits and Kimi, reserves | rewrite |
| §18 «Безопасность» (L1408–1441) | 8 | 152-ФЗ recipients, the gate checklist (data controls, credits, Extra Usage), «Получатель в Kimi не установлен» | rewrite |
| §19 «Инфраструктура» (L1462, L1497) | 2 | `egress-1` hosts; the P3.0 exception with `CODEX_HOME/auth.json` | rewrite |
| §20 «Риски и открытые вопросы» (L1512–1731) | 27 | risk table; questions 5–9, 14, 15, 21, 27, 29, 31; lawyer questions L1571–1572; R24, R102. L1688 already records the decision of 04.10.2026 | rewrite, keep decided items as a dated record |
| §21 «План работ» (L1776–1814) | 9 | P3.0 list, owner's acceptance, eval profiles | rewrite |
| «Источники» (L1821–1829) | 5 | Codex, Kimi, ChatGPT links | rewrite |

| Path | What it is | Verdict | Reason |
| --- | --- | --- | --- |
| `CLAUDE.md` (22 lines: 14, 21–35, 48, 57, 70, 79–82, 104, 121, 128, 135, 176–178) | state, stack, commands, structure, rules 1, 2, 8, «Расхождения» (Codex credit price, Kimi recipient, personal subscriptions) | rewrite | rule 1 at `HEAD` already carries the decision of 04.10.2026 and says the text still describes the old path until the pivot |
| `README.md:13,45,137-159,172` | status and stand commands | rewrite | — |
| `docs/plan/roadmap.md` (37 lines) | P3 with B1–B14 and gates (L55–75), P4 (L78), P5 (L79–80), P14 (L127–137), P15 (L139), M6 (L153) | rewrite | P3.0, «гейт схема A», owner's acceptance on Codex and Kimi lose their subject; done items stay as a dated record |
| `docs/business.md` — «Коротко» (L15), §1 (L27, 49, 50, 64, 66), §4 (L160), §5 «Модели и железо» (L166–236), «Источники» (L458) | resources, pool cost example «3 Codex Pro + 2 Kimi Pro = $378», windows, accounting rates, risks | rewrite | unit economics of one plan with windows and quotas |
| `docs/model/Raditi_unit_economics.xlsx` | workbook; its strings still price Cloud.ru models (Qwen3-Coder-Next, GLM-5.1, gpt-oss-120b) per token | rewrite | stale since 28.09.2026, never moved to subscriptions |
| `docs/landing/README.md:74`, `docs/landing/landing.dc.html:815,924,972` | landing rules and prototype | rewrite | section 6 |
| `docs/plan/00–36` (34 files with a name) | reports of bootstrap, P1–P6, review | keep as history | reports 13, 14, 19, 20, 22, 23, 30 describe the removed adapters, drivers and stands |
| `docs/research/2026-09-subscriptions/*` (9 files), `2026-09-bootstrap/*` (4 with a name) | research and the P3 design | keep as history | the README of the first deserves one line «superseded 04.10.2026» |

## 3. Orphaned machinery — generic by form, Codex-only by function (decide)

GLM Coding Plan is a key, like Kimi: no OAuth, no device flow, no provider-side revoke. After the
adapters are deleted nothing implements these optional parts of the port:

| Piece | Where | Only implementer today |
| --- | --- | --- |
| `LlmBackend.refresh`, `RefreshOutcome` | `packages/domain/src/ports/llm-backend.ts:306-310,398` | `openai-chatgpt/auth.ts` |
| `LlmBackend.login`, `DeviceLogin`, `DeviceLoginState`, `DeviceLoginResult` | `llm-backend.ts:312-338,399` | `openai-chatgpt/login.ts` |
| `LlmBackend.revoke` | `llm-backend.ts:402` | `openai-chatgpt/auth.ts` |
| `SubscriptionRefresher` (single writer, CAS recovery, retry after 401, provider revoke) | `apps/orchestrator/src/llm-gateway/refresher.ts`, wired in `llm-app.module.ts:67,97,166,196` | selects backends by `backend.refresh` / `backend.revoke` (`refresher.ts:150,181`) |
| device-flow branch, terminal display of the code | `subscriptions/device-login.ts:52+`, `secret-input.ts`, `cli.ts:165,175,356` | Codex |
| health reasons `refresh_ambiguous`, `vault_write_pending`, `refresh_region`; pause on an expired access token | `refresher.ts:59`, `packages/domain/src/llm/pool.ts:96`, `llm/turn-credentials.ts:438-463` | Codex |
| `ClientIdentity.installationId` (Codex), `deviceId`/`deviceName` (Kimi `x-msh-device-*`) | `llm-backend.ts:240-247`, `subscription_accounts.client_identity` | both |
| `creditsBalance`, `credits_seen` | `llm-backend.ts:116-137`, `pool-health*.ts`, `store.ts` | Codex `x-codex-credits-*` |
| stand pieces | `scripts/verify-refresh-worker.mjs`, rotation barriers in `verify-llm-crashes.mjs`, OAuth endpoints of `fake-subscriptions.mjs` | Codex |

Two consistent answers: delete them with Codex («всё, что обслуживает только их»: about 2 100 lines
of `refresher.ts` and its tests, plus the port members), or keep them as untested-against-anything
code for a future OAuth provider. Keeping them costs a fake OAuth backend in the stands forever;
deleting them is a larger diff in code that touches secrets and must go with its tests. The
session lock (`session-lock.ts`) is **not** orphaned: login, relogin and retirement use it.

## 4. Generic — must not be deleted

It is named «subscriptions», «pool», «windows», but written against the ports and needed for one
key-based provider exactly as for two:

- `apps/orchestrator/src/llm-gateway/` — `server.ts`, `store.ts`, `pool-health*.ts`,
  `credentials.ts`, `egress*.ts`, `session-lock.ts`, `llm-app.module.ts`; `src/llm/` — turn keys,
  sweeper, pool probe client; `src/subscriptions/` — `login.ts`, `retire.ts`, `secret-input.ts`,
  the three operator commands; `src/config/llm-config.ts`.
- `packages/domain/src/llm/*` and the port `LlmBackend` itself (routes, body policy hook, meter,
  `classify`, windows, `probe`, `importCredential`, declared egress origins).
- `packages/llm-backends/src/{shared,sse,usage,stream-errors,data-url}.ts`.
- `packages/agent-drivers/src/{cli-run,config,jsonl}.ts`.
- Database: every table of the gateway (`subscription_accounts`, `task_account_bindings`,
  `llm_keys`, `llm_calls`, `token_usage`, `cross_border_clearances`, `llm_model_prices`).
- `infra/app` profile `llm` with firewall and preflight; `infra/vault` mounts `subs/`, `turns/`
  and the policies `llm-subscriptions`, `subscriptions-writer`, `subscriptions-admin`;
  `infra/egress/llm-egress.mjs`; `infra/sandbox` gateway, guards and watchdog;
  `infra/dev/llm-verify/{stack,workers,certificates}.mjs`.
- CI job `sandbox-isolation` inside `codex-driver.yml`; jobs `gateway-db` and `storage-s3` of `ci.yml`.
- Tests «refuses a removed driver» for `gigacode`/`sourcecraft` — keep and extend.

## 5. Safe order (replacement first, removal second)

Every step leaves `pnpm gates` green; a provider is deleted only after its last importer is re-pointed.

1. **Add, delete nothing.** New backend id in `llmBackendIds`; new adapter in `packages/llm-backends`
   and in `llmBackends`; `prepare`/`command` of the OpenCode driver; `opencode-ai` in the CLI lockfile
   and the Dockerfile next to the two old CLIs; the new route and headers in `sandbox-gw` next to the
   old ones; provider and model seeds; override variable in `.env.example` and `turbo.json`;
   `api.z.ai:443` in the stand allowlists; a fake Z.ai in `fake-subscriptions.mjs`.
2. **Prove the replacement on the same stands** (section 7): `verify:opencode`, the supervisor stand,
   `verify:llm-gateway`, `verify:agent-content`, `verify:runner`, plus `verify:llm-app`, `verify:vault`,
   `verify:db`. Only after they pass does removal start.
3. **Switch the product default**: `ENABLED_AGENT_DRIVERS = ['opencode']`, the `cli.ts` import table,
   the new migration (section 2.4), the seed. In the same change — the landing sentence and
   `PRODUCT.md` (section 6): from this moment «OpenAI и Moonshot» on the landing is untrue.
4. **Retire existing accounts while their adapters still exist.** `subscriptions:retire` needs the
   adapter of the account's provider (`retire.ts:291`, refusal `unsupported` without it), and only
   the Codex adapter can revoke its OAuth tokens at the provider. Whether any account row exists in
   the dev database is unknown (section 9); a fresh database has none.
5. **Re-point the importers**: the 16 orchestrator test files and 8 scripts that import
   `codexBackend`, `kimiCodeBackend`, `createCodexDriver`, `createKimiDriver`
   (sections 2.6, 2.7), `infra/dev/llm-verify/fake-subscriptions.test.mjs`; delete
   `backend-adapter.mjs`, `local-spike.mjs`, `record-proxy.mjs` with their tests.
6. **Delete the adapters**: `packages/llm-backends/src/openai-chatgpt/`, `kimi-code/`; then decide
   section 3.
7. **Delete the drivers**: `codex*`, `kimi*`, `qwen*`, their fixtures, `verify-codex.mjs`, the
   supervisor launchers and runner fixtures; shrink `registry.ts`, `index.ts`, `session-paths.ts`.
8. **Shrink the image and the gateway**: remove both npm packages from the lockfile, the `npm ls`
   lines and symlinks from `infra/sandbox/Dockerfile` and `cli.Dockerfile`; remove the old routes
   and `x-codex-*`, `x-openai-*`, `x-msh-*` handling from `gateway.mjs` with its two test suites.
   Not earlier: until step 7 the old CLIs still call these routes in the stands.
9. **Shrink the ids last**: `agentDriverIds`, `llmBackendIds`. Before it, rename the sample ids in
   the 64 touch files, or the tree stops compiling; add the removed ids to the «refused» tests.
   Consequence, same as for `gigacode`: a stored snapshot manifest or a non-terminal
   `turn_assignments.plan` with `codex`/`kimi` is refused on restore. Only synthetic data exists.
10. **Environment and CI**: drop the three override names from `.env.example`, `turbo.json`,
    `llm-preflight.test.mjs`, `verify-llm-app.mjs`; hosts from `infra/egress/env.example` and
    `compose.llm.yml`; rename `codex-driver.yml` together with `infra/app/ci.test.mjs:233`;
    root and orchestrator `package.json` scripts.
11. **Documents**: `docs/spec.md`, `CLAUDE.md` (rules 1 and 2 lose the P3.0 and 29.09.2026
    exceptions together with `record-proxy` and `local-spike`), `README.md`, `roadmap.md`,
    `business.md`, the workbook, stand READMEs. Reports and research stay.
12. **Legal texts with new editions** — with the lawyer, before the 152-ФЗ gate; until then only
    synthetic data goes to the model (`issue` enforces it through `cross_border_clearances`).

## 6. Client-facing and legal text that names the recipients

The recipient of client data changes to Z.ai; every line below names OpenAI, Moonshot, Codex, Kimi
or their country. Line numbers — `HEAD`.

Product (shown to visitors):

- `apps/web/src/components/landing/landing.tsx:85` — FAQ answer «Задания обрабатывают модели OpenAI
  и Moonshot за рубежом; переданные им копии могут храниться по условиям этих провайдеров». In the
  working tree the same sentence is at line 93, and an untracked `landing.test.tsx:191` asserts it.
- `apps/web/PRODUCT.md:28` — the rule the landing copy follows.

Legal texts (`apps/web/content/legal/`):

- `consent.md:118` — recipients «OpenAI, L.L.C. (США) … сервис Codex, и Moonshot AI … сервис Kimi Code»;
  `consent.md:134` — «OpenAI (США) и Moonshot AI ([ЮРИСТ: КНР или Сингапур]) — через узел связи в
  [СТРАНА УЗЛА СВЯЗИ]. США не входят в перечень…».
- `privacy-policy.md:203` (п. 8.4), `:205` (п. 8.5: отказ от обучения «в настройках каждого аккаунта
  (OpenAI) … (Moonshot AI)»), `:260` (п. 11: получатели), `:283` (п. 13.1: «в США (OpenAI) и
  [ЮРИСТ: КНР или Сингапур] (Moonshot AI)»).
- `public-offer.md:212` (п. 9.8: «условия Kimi допускают коммерческое использование… только с
  письменного согласия Moonshot AI»), `:224` (п. 10.5).
- `user-agreement.md:220` (п. 9.8, то же о Kimi), `:234` (п. 10.5).
- Depend on those clauses without a name and must be re-read: `privacy-policy.md:261` (провайдер узла
  связи), `:293` (13.6), `:295` (13.7), `:350-351` (меры: шлюз, отключение обучения в аккаунтах);
  `consent.md:136`; `public-offer.md:148` (6.11 «в пределах провайдеров, указанных в пункте 10.5»),
  `:240` (11.6); `user-agreement.md:178`, `:339` (15.7), `:378` (17.4).
- `content/legal/README.md:9,49,51,64,65,72-76,82,95,105,117` — the lawyer's brief: section
  «Трансграничная передача в OpenAI и Moonshot», recipients, consumer terms, training opt-out, dossier
  for ч. 5 ст. 12.
- `packages/domain/src/legal/documents.ts:30,37,44,51` — editions `2026-09-29`; a new edition makes
  every user accept again (`missingRequiredConsents`).

Prototype and internal copies of the same statements:

- `docs/landing/landing.dc.html:815`, `:924`, `:972` (the checkbox «согласие на передачу данных
  ИИ-моделям OpenAI и Moonshot за рубежом»); `docs/landing/README.md:74`.
- `docs/business.md:64,66,160`; `docs/spec.md:35,187,1007,1408,1430,1434,1571-1572`;
  `CLAUDE.md:121,177,178`; `.claude/agents/spec-reviewer.md:13`.

Not present in the product yet: a separate cross-border consent (no such type in
`consentDocumentTypes`; only the prototype has the checkbox). When it is built, it names Z.ai.

What follows for the 152-ФЗ documents: the recipient's legal entity and country, the sentence about
the «adequate protection» list (today written for the USA), the training opt-out and retention
wording, clause 9.8 about rights to the result, and the notice under ст. 12 — all are per recipient
and have to be redone for Z.ai. A clearance row for the old providers does not transfer.

## 7. Tests and stands that lose their subject

| Loses its subject | What it proves today | Replace with |
| --- | --- | --- |
| `pnpm verify:codex` (`packages/agent-drivers/scripts/verify-codex.mjs`; CI job `verify-codex`) | real Codex CLI + driver in containers without external network: exec, resume in a new container, a stream cut mid-answer | the same with the real OpenCode CLI against a local fake of Z.ai; same three checks |
| `pnpm verify:codex-supervisor`, `pnpm verify:kimi-supervisor` (`verify-agent-supervisor.mjs` → `verify-runner.mjs --codex / --kimi` + two runner fixtures) | supervisor, pull runner under gVisor, encrypted snapshots, local Git publication, two turns of the real CLI; Kimi adds the long Unicode prompt and hostile project config (`.kimi-code/…`) | one OpenCode supervisor stand; keep the long Unicode input and the hostile project config case (OpenCode reads project `opencode.json`/`AGENTS.md`) |
| `pnpm --filter orchestrator verify:runner` (seven scenarios) | P2 gates 2–3 with a synthetic agent that prints Codex JSONL and uses Codex session state | keep the stand; the synthetic agent prints OpenCode events and writes its session files |
| `pnpm verify:llm-gateway` (B13, 53 checks) | real Codex and Kimi CLIs through `sandbox-gw` → role `llm` → fakes over mTLS: retries, turn keys, pool, budget, windows, in-stream failures, lifecycle, SIGTERM clean-up | same stand with the real OpenCode CLI and a fake Z.ai. New cases the old fakes never had: an error delivered as HTTP 200 with `{code: …}`; a stream failure as `response.failed`/`error` then `[DONE]`. Lost for good: OAuth refresh, device login, rotation crash barriers (`verify-llm-crashes.mjs`, `verify-refresh-worker.mjs`) |
| `pnpm verify:agent-content` (N2; CI `agent-content.yml`) | both CLIs edit a page of a real WordPress through `sandbox-gw`, role `llm` on fakes and the real role `mcp`: snapshot before the write, replay without a double edit, refusal of a forbidden call, site lease | the same four checks with OpenCode on the scenario model (spec L1688: deterministic stands stay on the scenario model) |
| `record-proxy.mjs`, `local-spike.mjs`, `backend-adapter.mjs` (P3.0 tools, report `docs/plan/14-p3-codex-live.md`) | scheme A on the owner's live Codex subscription | a short recording pass against Z.ai, if a live check of the wire is wanted; `cli-proxy.mjs` in this directory (a recording pass-through to `https://api.z.ai/api/v1`, written for the stopped Codex-on-GLM probe) is a start |
| `packages/llm-backends/src/openai-chatgpt/*.test.ts` (5), `kimi-code/*.test.ts` (2), `stream.test.ts` | body policy, SSE meter, signals, windows, probe, refusals shaped for each CLI's retry rules | the same list for the new adapter: body policy, usage (where GLM reports it and whether cache and reasoning are split), `classify` incl. HTTP 200 errors, windows from the quota answer, refusals OpenCode ends a turn on |
| `packages/agent-drivers/src/{codex,kimi,codex-verifier}.test.ts`, the Codex/Kimi/qwen halves of `events`, `drivers`, `session-paths`, `registry`, `cli-run`, `prepared-run` tests | `prepare`/`command`, protected settings, secrets only on tmpfs, session files allowlist | `opencode.test.ts` with the same invariants: no key in files, env or argv; project config cannot override the provider; only `opencode.db` + WAL in the snapshot |
| orchestrator tests on real adapters (14 files + `cli.test.ts`, section 2.6) | generic gateway, login, retirement and turn output, driven through the old adapters | the same tests on the new adapter and driver |
| `subscriptions/device-login*.test.ts` (device-flow part), `llm-gateway/refresher*.test.ts` | device login and OAuth rotation | nothing, if section 3 is decided as «delete»; else a synthetic OAuth backend |
| `infra/sandbox/gateway.test.mjs`, `packages/sandbox-providers/.../gateway.integration.test.ts` | exact routes, header allowlists, `x-msh-*` limits | the new route and the headers OpenCode really sends |
| `packages/db/prisma/seed/data.test.ts` | seeded drivers, providers and profiles | the new catalogue; a migration test in the style of `subscriptions-expand.test.ts` for the retiring migration |
| CI `codex-driver.yml`, `llm-gateway.yml`, `agent-content.yml` | run the three stands above | same workflows on the new stands; path filters unchanged |

## 8. Findings worth the lead's attention

- `sandbox-gw` routes are a literal list in `infra/sandbox/gateway.mjs:68`, independent of
  `LlmBackend.routes`: forgetting one of the two places gives a 403 in the sandbox, not a compile error.
- The seed never re-enables an existing `agent_drivers` row (`apply.ts:92-104`): without the
  migration step the driver `opencode` stays disabled on every database seeded before the pivot.
- `docs/spec.md:1688` says the key lies locally in `.env` (`ZAI_API_KEY`). Rule 2 (`CLAUDE.md`) says
  test subscriptions live in OpenBao through `subscriptions:login`, not in `.env`, and a root `.env`
  value is loaded by every role started from it. The existing key-import path
  (`importCredential`, the Kimi branch of `device-login.ts:43-51`) puts the key where only the role
  `llm` reads it.
- `docs/model/Raditi_unit_economics.xlsx` was not updated on 28.09.2026 either: it still prices
  Cloud.ru per-token models.
- Applied migration comments (`20260929130000…:20,35`) will keep the words `chatgpt_account_id` and
  `x-codex-credits-*` forever: «no remains» cannot include applied migrations, reports and research.

## 9. Unknowns

- Which wire OpenCode will use for GLM (chat/completions on `/api/coding/paas/v4`, Anthropic
  messages, or Responses on `/api/v1`) — it decides which old adapter is the template and which
  route `sandbox-gw` gets. The probe agent answers it.
- Whether `opencode-ai` installs with `npm ci --ignore-scripts` (its platform binary) and runs under
  uid 10001 with a read-only rootfs.
- Whether `api.z.ai` is reachable from Russian hosting without `egress-1`. If it is and the owner
  drops the node, `infra/egress`, the mTLS channel, the app-VM firewall rule «outbound only to the
  proxy» and the egress probe change from «rewrite hosts» to a redesign.
- Z.ai's legal entity and country, the terms of GLM Coding Plan (use through a gateway, commercial
  use, several accounts), training opt-out and retention — for the lawyer.
- How Z.ai reports the plan's windows and quotas (headers or a usage endpoint) and how many
  concurrent requests one plan allows — it sets `maxConcurrentTurns`/`maxConcurrentRequests` in `cli.ts`.
- Whether any `subscription_accounts` row or `subs/` secret of the old providers exists in the dev
  database and dev OpenBao (the root `.env` and the dev containers were not read).
- Section 3: delete the OAuth machinery or keep it — the owner's or the lead's decision.
