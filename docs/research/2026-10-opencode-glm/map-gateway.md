# Gateway map: one provider — Z.ai with the GLM Coding Plan

Reader's notes, 04.10.2026. Source: the committed state of `codex/p3-llm-gateway` at `c9be168`
(`git show HEAD:<path>`); the gateway paths have no uncommitted changes (only
`packages/db/prisma/schema.prisma` differs in the working tree, and that diff touches no
gateway table). Nothing was written into the repository. Line numbers are those of HEAD.

Working names used below (naming is the designer's choice, not a fact):
backend id `zai-coding` (= `llm_providers.slug`, Vault segment, pool lock key),
gateway route `POST /zai/v4/chat/completions` (OpenCode appends `/chat/completions` to its
`baseURL`, so the sandbox base would be `http://sandbox-gw:8080/zai/v4`),
override variable `LLM_BACKEND_URL_ZAI_CODING`.

## 0. Verdict in ten lines

1. The gateway is already written against one port (`LlmBackend`); the two providers are named
   in exactly one enum of the domain, one registry array, one operator map, the seeds, the
   sandbox-gw allowlists and the egress allowlists. A third backend is an added adapter plus
   list entries; **no migration, no Vault policy, no change to the store, the credentials cache,
   the egress transport, the pool, the issue of turn keys, login or retirement**.
2. The Z.ai adapter is the Kimi pattern almost line for line: a key imported from stdin,
   OpenAI-style chat completions over SSE, usage in the stream, quotas from a control request.
3. The one hard dependency: **the pool admits nothing while an account's windows are unknown**
   (`pool.ts:114`, `store.ts:737`), response headers of Z.ai carry no limits (samples 20, 23),
   so the adapter's `probe` must read the plan's quota from a Z.ai endpoint. That endpoint was
   not probed with the key today (section 8, unknown 1). Without it the replacement needs a
   product change in generic pool code.
4. On the coding chat path errors come with real HTTP statuses (401 measured here without a key,
   section 1), so `server.ts` needs no change for them. The HTTP-200 envelope
   `{code,msg,success:false}` belongs to `/api/v1` and to the monitor paths, where only the
   adapter's own `probe` reads it.
5. The code assumes an mTLS CONNECT proxy unconditionally: there is no direct path to a
   provider. For Z.ai the proxy's allowlist gets `api.z.ai:443`; whether the node may stand in
   Russia or be dropped is not something the code or today's probes establish.
6. Once Codex and Kimi are gone the whole OAuth half is dead: refresher rotation, device
   flow, token revocation, refresh-on-401, plan/credits/402 handling, four DB columns.

## 1. Facts about Z.ai that the gateway side depends on

| Fact | Evidence |
| --- | --- |
| `POST https://api.z.ai/api/coding/paas/v4/chat/completions`, `stream:true`, `stream_options.include_usage` → HTTP 200, `content-type: text/event-stream;charset=UTF-8`, chunks `data: {…choices:[{index,delta:{role,reasoning_content|content}}]}`, the last chunk carries `finish_reason:"stop"` **and** `usage` together, then `data: [DONE]` | `samples/23-coding-chat-stream.json` |
| Usage shape: `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` (reasoning inside completion: 47 of 51) | samples 20, 23 |
| Response headers: `alt-svc`, `content-type`, `date`, `ga-traceid`, `set-cookie: acw_tc=…`, `vary`, `x-log-id`, `x-request-id`. No rate-limit or quota header | samples 20, 23 |
| Invalid key on the coding chat path → **HTTP 401**, `application/json`, `{"error":{"code":"401","message":"token expired or incorrect"}}`, the same with `stream:true`; no key → HTTP 401 `{"error":{"code":"1001",…}}` | my request without any key, synthetic body `ping`: `run/map-gateway-probe.txt` |
| No plan on the pay-as-you-go path → HTTP 429 `{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}` — error object with a numeric code as a string | `samples/21-paas-chat.json` |
| `/api/v1/*` (Responses) and `/api/monitor/*` answer errors as **HTTP 200** `{"code":401|1001|500,"msg":…,"success":false}` | samples 10, 10b, 10c, 14; `run/map-gateway-probe.txt` |
| `GET /api/monitor/usage/quota/limit` without a key → HTTP 200 `{code:1001}`; with an invalid key → HTTP 200 `{code:401}`; an invented monitor path without a key answers the same `{code:1001}` — authentication is checked before routing, so the path's existence is **not** proven | `run/map-gateway-probe.txt` |
| Model ids on the coding path: `glm-4.5 … glm-5.3, glm-5.3-flash, glm-5.3-flashx, glm-5-turbo` | `samples/24-coding-models.json` |
| `models` answered `content-encoding: gzip`; `accept-encoding: identity` is honoured | sample 24; `progress/probe.md` last line |
| The lead's probes used Node `fetch` (HTTP/1.1, Node's bundled roots) and got answers — consistent with what `egress.ts:149-156` does inside the tunnel (ALPN `http/1.1`, `rootCertificates`) | `probe-endpoints.mjs`, samples 20–24 |

## 2. Place by place

Legend — **G**: generic, works for any adapter; **2B**: written for the two backends (names,
paths or protocol of Codex/Kimi); **OA**: exists only for OAuth (Codex).

### 2.1 `packages/domain` (port and pure rules)

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `src/ports/llm-backend.ts:4` `llmBackendIds = ['openai-chatgpt','kimi-code']` | The only enumeration of backends; feeds `llmBackendIdSchema` used by the grant (`turn-credential-grant.ts:15`), the pool snapshot (`llm/pool.ts:20,39`), the store (`store.ts:60,625`), pool health (`pool-health-store.ts:122`), the operator CLI (`cli.ts:59`) | 2B | Changed line: add `'zai-coding'`; after the removal the tuple has one member |
| `:58-64` `limitWindowSchema.name` `5h/week/month`; `:78-93` reset horizons 6 h / 8 d / 32 d | Window vocabulary of the pool | G | Nothing if the plan's quotas are a 5-hour cycle, a week, a month. Another period needs a new name here and in `limitResetHorizonMs` |
| `:96-112` `callSignalSchema`, `:169-212` `gatewayRefusalSchema` + `refusalForSignal` | Ten signal kinds → ten refusals | G | Nothing; the adapter maps Z.ai error codes onto them |
| `:119-127` `probeResultSchema` (`status`, `windows`, `plan`, `creditsBalance`) | Result of the content-free account check | G (credits: Codex) | Nothing; Z.ai returns `plan: null`, `creditsBalance: null` |
| `:215-235` `SubscriptionCredential`, `CredentialMetadata` | Opaque Vault payload + login facts | G | Nothing; a key gives four nulls |
| `:248-275` `LlmEgressOrigin` + schema (`overrideEnv` must match `^LLM_[A-Z0-9_]+$`, requests are exact `METHOD URL`) | The adapter declares every provider request | G | Nothing in the port; the adapter declares `api.z.ai` |
| `:296-338` `RefreshOutcome`, `DeviceLoginState`, `DeviceLoginResult`, `DeviceLogin`; `:397-402` optional `refresh`, `login`, `revoke` | OAuth contract | OA | Nothing (the adapter omits them). Dead after the removal |
| `:341-403` `LlmBackend` | The port | G | New implementation only |
| `src/ports/turn-credential-grant.ts:14-15` `driverId: z.enum(agentDriverIds)`, `backend: llmBackendIdSchema` | Shape of the issue policy | G (via the enum) | Nothing: `agentDriverIds` (`ports/agent-driver.ts:15`) already has `opencode` |
| `src/llm/pool.ts:6-14` policy, `:89-99` `eligible`, `:109-144` `readiness`, `:221-255` `pickAccount` | Account choice from a snapshot. `:114` — no windows = unknown = not ready; `:130-133` a new task needs 10 % of the `5h` window; `:96` excludes `refresh_ambiguous` (OA) | G | Nothing if windows are readable. If not — see section 3, fork B |
| `src/llm/budget.ts`, `cost.ts`, `money.ts`, `model-class.ts`, `json-policy.ts` | Decimal budget, reserves (first call = 40 000 input + `reserve_output_tokens`, `budget.ts:128-136`), ceilings 135/285/735 ₽ (`model-class.ts:9-13`), JSON limits and token estimate | G | Nothing |

### 2.2 `packages/llm-backends`

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `src/index.ts:3-8` registry `llmBackends = [codexBackend, kimiCodeBackend]` | The set every consumer reads: egress transport (`egress.ts:56`), role config (`llm-config.ts:25,113`), role module (`llm-app.module.ts:54`), operator CLI (`cli.ts:155`) | 2B | Changed line: export and register the new adapter |
| `src/shared.ts`, `sse.ts`, `usage.ts`, `stream-errors.ts` | Control request (20 s, 64 KiB, no redirect), SSE decoder (16 MiB/event), meter helpers, safe stream error | G | Reused as is |
| `src/data-url.ts` | Inline image check, used by both body policies | G | Only if the policy admits `image_url` parts (the seed says OpenCode has `images: false`, `seed/data.ts:144-150`) |
| `src/kimi-code/backend.ts` (222 lines) | `:20-30` credential `{v:'1',kind:'kimi_api_key',apiKey}`; `:32-45` auth + device headers; `:48-53` pinned CLI user agent; `:55-57` URLs; `:92-128` quota → windows; `:135-164` `probe`; `:168-172` `importCredential`; `:173` route; `:177-183` egress; `:219` `windowsFromHeaders: () => null` | 2B, the pattern | **New files** `src/zai-coding/{backend,body,errors,stream,usage}.ts` + fixtures + tests. Credential `{v:'1',kind:'zai_api_key',apiKey}`; `upstream` sets `authorization: Bearer <key>`, `accept-encoding: identity`, `accept: text/event-stream`; no `x-msh-*` device headers (the stored `clientIdentity` is simply unused); `clientHeaders`/`validateClientHeaders` pin what OpenCode sends (from `opencode-protocol.md`); `responseHeaders: []`; egress `{origin:'https://api.z.ai', requests:['POST …/api/coding/paas/v4/chat/completions', 'GET <quota URL>'], overrideEnv:'LLM_BACKEND_URL_ZAI_CODING'}` |
| `src/kimi-code/body.ts` (158) | Strict zod policy of the Kimi CLI request; `:124` model must equal the profile's model and `cacheKey` must be `rdt_…`; `:126-140` effort cap through `thinking`; `:141-143` forces `stream`, `include_usage`, `prompt_cache_key` | 2B | New policy for what OpenCode really sends (fields, `max_tokens`, tools, `thinking`/`reasoning_effort`). It must force `stream: true` + `stream_options.include_usage` — the server accepts only SSE (`server.ts:806`). Whether to inject `prompt_cache_key` on this endpoint is unknown (accepted and echoed on `/api/v1`, sample 06) |
| `src/kimi-code/usage.ts` (82) | Chat-completions meter: deltas of `content`, `reasoning_content`, tool arguments; usage from `event.usage` with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`; `completed` only after a `finish_reason` | 2B by name, protocol-generic | The Z.ai stream has the same shape (sample 23) — the same code works; either a copy in the new directory or the file is moved to a shared `chat-completions` module when Kimi is deleted |
| `src/kimi-code/stream.ts` (52) | In-stream error → failure event; a final refusal is sent as a `content_filter` chunk because the Kimi CLI retries every in-stream error | 2B (CLI behaviour) | New inspector: how OpenCode treats an in-stream error and which shape ends its turn — measured by the protocol probe, not known here |
| `src/kimi-code/errors.ts` (126) | `:7-22` exact Kimi messages; `:42-81` `classify`; `:96-126` `refusal` 503 / 400 / 429 with `raditi_<kind>` | 2B | New `classify` keyed on `error.code` (measured: `"401"`, `"1001"`, `"1113"`); new `refusal` shaped for OpenCode — its retry rules decide the statuses (unknown 3) |
| `src/openai-chatgpt/**` (11 files) | Codex Responses policy, OAuth credential, refresh, revoke, device login, headers→windows, credits | 2B + OA | Nothing. Dead after the removal |

### 2.3 `apps/orchestrator/src/llm-gateway` (role `llm`)

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `server.ts:301-306`, `:444` | Route table built from `backend.routes`, exact `METHOD path` match | G | Nothing |
| `:57-58`, `:132-149`, `:505` | Client headers = `authorization, content-type, accept` + the adapter's `clientHeaders`; duplicates refused | G | Nothing |
| `:597-609` | Turn key pattern, lookup, `key.backendId !== selected.backend.id` → 403 `raditi_backend` | G | Nothing |
| `:611`, `:629` | `validateClientHeaders`, `normalizeBody(route, body, key)` | G | Nothing |
| `:647-706` | Admission loop: in-memory pause, `store.admit`, slot wait ≤ 20 s, one probe when windows are unknown | G | Nothing |
| `:707-748` | Credential from the Vault cache, `upstream`, egress request | G | Nothing |
| `:750-802` | Non-2xx → `classify` → refusal. `:760-792` refresh and one retry on 401 only when `backend.refresh` exists | G; the retry is OA | Nothing: without `refresh` a 401 goes straight to `account` and a probe |
| `:803-808` | A 2xx answer must be `text/event-stream`, else `Invalid upstream headers` → transient refusal, estimated non-billable usage, no signal | G | Nothing while generation errors come with HTTP statuses (measured for auth). **Conditional change**: if any coding-path error turns out to be HTTP 200 JSON, add before the throw «2xx, JSON body → bounded read → `backend.classify` → refusal, `providerMayCharge = false`» |
| `:821-868` | Stream through the adapter's inspector, meter, 64 MiB cap, idle 300 s | G | Nothing |
| `:897-963` | Close: usage or estimate, `windowsFromHeaders`, `store.finish`, `lifecycle.observe` | G | Nothing |
| `:446`, `:537-590` | `POST /internal/subscriptions/probe` for `core` | G | Nothing |
| `store.ts:187-301` `admit` | `:207` provider must be `kind='subscription'` and enabled; `:209` model enabled with `provider_model_id`; `:211` policy flag; `:212-213` ≤ `LLM_MAX_REQUESTS_PER_KEY` open calls per key; `:214-218` accounting rate; `:224-243` reserve and key budget; `:244-249` account state, unknown windows → probe; `:250-256` account request slots; `:385` account must belong to the key's provider **and** driver | G | Nothing in code; rows — section 2.5 |
| `store.ts:404-584` close | Cost from the rate at call start; `:514-529` usage breaker (3 completed calls without usage → 15 min); `:530-550` windows from the response; `:546-549` credits (Codex); `:551-569` `window_exhausted` → cooling or windows dropped | G | Nothing |
| `store.ts:625-647` `toKey` | Slug parsed by `llmBackendIdSchema`; `cacheKey = rdt_<sha256(taskId)[:32]>` | G | Nothing |
| `store.ts:718-748` `accountRefusal` | `:729-733` `refresh_ambiguous` (OA); `:737` windows null or empty → `windows_unknown` | G | Fork B only |
| `credentials.ts:34-62`, `:64-72`, `:80-184` | One KV string `{credential: <json>}` ≤ 32 KiB, parsed by the adapter's schema; path must equal `subs/<backend.id>/<accountId>`; cache 30 s, stale-if-error 1 h | G | Nothing |
| `credentials.ts:17-28`, `:185-223` `install/commit/versionOf` | Pinning a rotated token until Vault and SQL agree | OA | Nothing; dead after the removal |
| `egress.ts:54-63` | No proxy configured → every request refused as never sent | G | Nothing |
| `egress.ts:64-97` | Only the exact `METHOD URL` the adapters declare; stand override of an origin to loopback | G | Nothing |
| `egress.ts:127-156` | CONNECT with mTLS (TLS 1.3, `servername` `egress-1.raditi.internal` for an IP), then own TLS to the provider (≥ 1.2, ALPN `http/1.1`, Node roots). The body is passed as bytes — **no content decoding**, so adapters must ask for `identity` | G | Nothing |
| `egress-probe.ts:16-78`, `:94-191` | Byte probe `GET /probe?bytes=65536` of the proxy; in-memory region block with a 10-minute recheck | G | Nothing |
| `pool-health.ts:88-159` | In-memory pauses 30/60/120 s on transient signals; `:108-117` 402 «payment» pauses 5/15/45 min and suspension (Kimi membership); `:133-136` credits (Codex); `:137-150` exhausted window → probe → cooling; `:151-155` `auth/account_risk/region/unconfirmed_block` → probe | G; 402 and credits are 2B | Nothing |
| `pool-health.ts:167-258` | One probe per account per 5 minutes, 20 s for unknown windows; `:248` `authNeedsRelogin: backend.refresh === undefined` | G | Nothing: a keyed backend goes to `needs_relogin` on a confirmed auth probe |
| `pool-health-store.ts:137-224` | Applies a probe: windows, cooling, `:192-196` `plan_changed` suspension when the probe names a plan other than the stored one, `:197-210` credits, `:211-219` auth/suspended | G | Nothing; note — if the Z.ai probe ever returns a non-null `plan`, it must equal the `--plan` given at import or the account is suspended |
| `refresher.ts` (756) | `:148-169` scheduled refresh only for backends with `refresh`; `:178-241` provider revocation only for backends with `revoke`; `:243-…` single-writer rotation with session lock, CAS recovery, ambiguous outcomes | OA | Nothing; with only a keyed backend both loops select no account. Dead after the removal |
| `session-lock.ts` | PostgreSQL session advisory lock per account | G | Kept: login, relogin and retirement use it too |
| `llm-app.module.ts:54-111`, `:189-202` | Composition from the registry; timers: collector 30 s, retire 60 s, pool 60 s, refresh 5 min, channel | G | Nothing |
| `config/llm-config.ts:21-27`, `:186-246` | Provider origins and override variables derived from adapters' `egress`; `:201-204` in production the proxy URL and three files are required together; `:209-225` overrides forbidden in production and loopback-only | G | Nothing in code; the new variable — section 2.8 |

### 2.4 `apps/orchestrator/src/llm` (role `core`) and `src/subscriptions`

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `llm/turn-key.ts:30-32` `subscriptionCredentialPath` → `subs/<backendId>/<accountId>`; `:39-44` pool lock `pool:<slug>`; `:57-60` `turns/t_<task>_<turn>_<epoch>` | Conventions | G | Nothing |
| `llm/turn-credentials.ts:383-492` `#select`, `:630-674` `requireKeyBudget`, `:675-702` `validateAssignment` | The issue gate — section 5 | G; `:452-464` «expired access token = pause» is OA | Nothing |
| `llm/credential-sweeper.ts`, `pool-probe-client.ts`, `llm.module.ts` | Key cleanup, retirement drain by slug (`:260-272`), control probe client | G | Nothing |
| `subscriptions/cli.ts:13`, `:158-179` | `imports` map: `codexBackend → driver 'codex', turns 1, requests 2, deviceUri`; `kimiCodeBackend → driver 'kimi', turns 2, requests 3` | 2B | **Changed case**: entry `zaiBackend → { driverId: 'opencode', turns: N, requests: M }`; N and M from the plan's real concurrency (unknown 5) |
| `cli.ts:184` help text names the two backends; `:198-199`, `:210-211` texts about console revocation and automatic revocation | 2B | Text |
| `cli.ts:320-330` | A keyed import requires `--plan`; login requires the mTLS channel and a passed byte probe | G | Nothing; the operator runs `subscriptions:login -- --backend zai-coding --label … --plan <plan> --vault-token-file …`, key on stdin |
| `device-login.ts:43-51` | Keyed path: `importCredential(stdin)` → `probe` → **must be `status === 'ok'`** | G | Nothing in code; binds the import to a working probe |
| `device-login.ts:52-93`, `:101-140` | Device flow; revoke of unsaved OAuth tokens | OA | Nothing |
| `login.ts:176-248` import, `:250-335` relogin, `:401-484` finish | Provider must exist with `kind='subscription'`, driver row must exist (`:195-198`); label unique among non-retired; account created disabled with `import_pending`, CAS write to Vault, then `health ok`. Relogin = key rotation under the same account (`externalAccountId` null equals null, `:381`) | G | Nothing |
| `retire.ts:303-314`, `:330-343` | A backend without `revoke` → stage `console_revocation_required` → operator revokes the key in the Z.ai console, then `--finalize --console-revoked` destroys all Vault versions | G | Nothing |

### 2.5 `packages/db` — schema, migrations, seeds

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `schema.prisma:871-895` `LlmProvider.slug VarChar(64)`, `kind` enum `api | subscription` | Backend = a row, not an enum | G | **New row** (seed) `slug 'zai-coding', kind 'subscription', enabled false` |
| `:897-923` `LlmModel` (`provider_model_id`, `model_class`, `reserve_output_tokens` CHECK 1024…131072 from `20260929120000_subscriptions_expand:13-14`) | Profiles | G | **New rows** (seed), e.g. `glm-5.3` per class; the seed convention is «disabled, operator confirms the id» (`seed/data.ts:207-209`) |
| `:928-948` `LlmModelPrice` | Accounting rates, append-only, never seeded (`seed/data.ts:249`) | G | **New rows by the operator** — the owner's approved rate for GLM; without one `issue` throws `LLM_PRICE_MISSING` |
| `:1001-1061` `SubscriptionAccount` (`driver_id` NOT NULL FK, `plan VarChar(32)`, windows, health, slots 1–8 / 1–16) | Pool account | G | Rows are created by `subscriptions:login`. Columns `credential_expires_at`, `credential_refreshed_at`, `refresh_finished_at`, `refresh_failures`, `credits_seen`, `external_account_id` stay null/zero for a key |
| `:1093-1134` `LlmKey` (`reasoning_effort VarChar(16)`, `budget_rub` ≤ 750), `:1137-1165` `LlmCall` (`route VarChar(64)`, `signal VarChar(32)`), `:953-997` `TokenUsage` | Turn keys, calls, usage | G | Nothing; the route path must fit 64 characters |
| `:1176-1195` `CrossBorderClearance` (per provider) | 152-ФЗ gate | G | A row for the Z.ai provider only after the new gate; until then workspaces stay `synthetic` |
| `:850-869` `AgentDriver` (string id) | Registry | G | Row `opencode` already seeded **disabled** (`seed/data.ts:173-178`); `enabled` is written on create only (`seed/apply.ts:92-104`), so an existing database needs `UPDATE agent_drivers SET enabled = true WHERE id = 'opencode'` — operator action or a new data migration; a fresh stand does it in its own script |
| All 18 migrations | No CHECK, enum, index or inserted row names a provider or backend (`git grep -i 'openai\|chatgpt\|kimi\|codex' HEAD -- packages/db/prisma/migrations` finds two SQL comments in `20260929130000_subscription_gateway:20,35`; no `INSERT INTO` in any migration) | G | **No new migration** for the replacement. Applied migrations stay untouched |
| `seed/data.test.ts:192,207` | Asserts `llmProviderSeeds` slugs **equal** `llmBackendIds` (same order) and every model's provider is in the list | G | Adding the id to the domain forces the provider seed in the same commit |
| `seed/data.ts:191-194`, `:210-247` | Two providers, four models | 2B | Changed data + `seed/data.test.ts:202-228` (per-provider expectations). After the removal: delete the old seeds; rows already in a database cannot be deleted (FK RESTRICT from models, accounts, keys, usage) → a **new data migration** `UPDATE llm_providers SET enabled=false …; UPDATE llm_models SET enabled=false …` for the two slugs, as `20260929120000:4-6` did for API providers |

### 2.6 `infra/sandbox/gateway.mjs`

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `:67-70` | LLM paths hard-coded: `/codex/responses`, `/kimi/v1/chat/completions`, POST only, exact `req.url` | 2B | Changed list: add the Z.ai route (it must equal the adapter's `routes[0].path`) |
| `:9-20` `llmRequestHeaders` | `authorization, content-type, accept, user-agent` + six Codex headers + the lite header; anything else is silently dropped | 2B | Add only the OpenCode headers the adapter declares in `clientHeaders`; `user-agent` is already there |
| `:27` `llmResponseHeaders` | `content-type, x-codex-turn-state, retry-after` | 2B | Nothing to add |
| `:112-114`, `:221-232` | Kimi `x-msh-*` passthrough (≤ 8, ≤ 256 chars) and the Codex lite-header check | 2B | Nothing |
| `:30-39` limits | 11 min LLM backstop, 16 MiB request, 64 MiB response | G | Nothing |
| Tests `infra/sandbox/gateway.test.mjs`, `packages/sandbox-providers/src/gateway/gateway.integration.test.ts` | Name both paths | 2B | New cases |

### 2.7 Egress: `infra/egress/**`, `infra/dev/llm-verify/egress.mjs`

What the code assumes (no statement about the network):

- `llm-config.ts:54-55,201-204`: no direct mode exists. Production refuses to start the role
  without `LLM_EGRESS_PROXY_URL` and the three TLS files.
- `egress.ts:58-63`: without a proxy every provider request is refused before any connection.
- `egress-probe.ts:17` + `llm-app.module.ts:107-109`: without a healthy proxy channel `ready()`
  is false → admission answers 503 (`server.ts:617-620`), probes are skipped
  (`pool-health.ts:168`), `/health` is degraded.
- `subscriptions/cli.ts:323-330`: `subscriptions:login` refuses to run without the channel.
- `infra/app/llm-firewall.mjs:80,195-207`: from the `llm-out` bridge only
  `EGRESS_PROXY_IP:443` and Vault `:8200` are accepted; `EGRESS_PROXY_IP` must be a public
  unicast IPv4. `llm-preflight.mjs:87-110,228-252` and `preflight.sh:81` require the proxy
  address and the client certificate, key and root.
- Nothing checks where the node stands. The reasons written down for the node are OpenAI's 403
  to Russian addresses and the 16 KB cut of Cloudflare-fronted hosts (`infra/egress/README.md:3`,
  spec §9 «Выход за рубеж», `docs/spec.md:824-830`) — both about the two old providers.
  Observation only: Z.ai's answers carry `acw_tc` and `ga-traceid`, not Cloudflare headers.

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `infra/egress/llm-egress.mjs:57-67`, `:316` | Allowlist is data: `LLM_EGRESS_ALLOW`, exact `host:port` | G | Nothing |
| `infra/egress/env.example:5` | `chatgpt.com:443,auth.openai.com:443,api.kimi.ai:443` | 2B | Add `api.z.ai:443`; after the removal it is the only pair |
| `infra/egress/README.md:3,180-183,224`, `nftables.conf` | Runbook names three hosts; firewall is host-agnostic | 2B text / G | Text |
| `infra/dev/llm-verify/egress.mjs:19` | Stand allowlist hard-coded to the three hosts | 2B | Add `api.z.ai:443` |
| `infra/dev/llm-verify/compose.yml:54`, `certificates.mjs:22,34` | Fake provider aliases and certificate SANs | 2B | Add `api.z.ai` |
| `infra/app/verify/compose.llm.yml:49` | Same allowlist for `verify:llm-app` | 2B | Add |

Dropping the node for Z.ai would be a separate decision and a product change in six places
(transport, config, channel probe, login command, firewall, preflight) plus rule 1 and spec
§9/§19. The smallest replacement keeps the node and adds one allowlist entry.

### 2.8 Vault, app VM, environment

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `infra/vault/policies/llm-subscriptions.hcl:2-4` `subs/data/*` read, update | Role `llm` reads and CAS-updates | G | Nothing |
| `subscriptions-writer.hcl:2-8` create/update on `subs/data/*`, read on `subs/metadata/*` | Import writes, cannot read back | G | Nothing |
| `subscriptions-admin.hcl:2-8` delete metadata, destroy | Retirement | G | Nothing |
| `core-turns.hcl` | Turn keys | G | Nothing |
| `infra/vault/bootstrap.mjs` | Mount `subs/` KV v2 `max_versions=1`, `cas_required` | G | Nothing |
| `infra/app/docker-compose.yml:258-292` llm service, `env.example:23-31`, `llm-firewall.mjs`, `llm-preflight.mjs`, `systemd/*` | No provider name anywhere | G | Nothing |
| `infra/app/llm-preflight.mjs:11-12` | Secrets env may not carry `LLM_BACKEND_*`, `LLM_AUTH_*`, … | G | A new override named `LLM_BACKEND_URL_…` is covered by the prefix |
| `infra/app/verify-llm-app.mjs:344-345` | Asserts the two override names are absent from the production service | 2B | Add the new name |
| `.env.example:43-45`, `turbo.json:18-20` | Three override variables | 2B | Add `LLM_BACKEND_URL_ZAI_CODING` to both (repo rule: new env → both files) |

### 2.9 Stand B13 and its fakes (`apps/orchestrator/scripts/verify-llm-*.mjs`, `infra/dev/llm-verify/**`)

| Place | Today | Kind | Z.ai needs |
| --- | --- | --- | --- |
| `fake-subscriptions.mjs:44-51` | Serves Codex Responses, `wham/usage`, Kimi completions and `usages`, device auth, OAuth token/revoke | 2B | Add the Z.ai chat path and the quota path with the measured shapes, incl. the HTTP-200 envelope for the quota path |
| `verify-llm-gateway.mjs:11,212-217` | Login with `[codexBackend, kimiCodeBackend]` | 2B | Third account through the operator command with the key on stdin (the Kimi branch, `:261-279`, is the template) |
| `:320-359` | Enables provider, model, rate, account windows, drivers | 2B data | Third tuple `['zai-coding', accountId, '<model slug>', 'glm-5.3']`, `opencode` in the driver list |
| `:401-413` | Grant: `driverId` by backend | 2B | `opencode` |
| `verify-llm-gateway-drivers.mjs:25-32,138` | Provider paths, base URLs, drivers | 2B | Third endpoint and `createOpencodeDriver` |
| `cli.mjs`, `cli.Dockerfile`, `backend-adapter.mjs`, `record-proxy.mjs`, `local-spike.mjs` | CLI container, P3.0 recon for Codex | 2B | The OpenCode binary in the CLI image is the driver map's subject; the recon tools are not needed |

### 2.10 Documents

`docs/spec.md` §9 (`:620-878`): table of shells `:626-636`, classes `:637-650`, gateway
`:651-742`, turn key `:743-755`, pool `:756-812`, accounting `:813-823`, egress `:824-830`,
shells in the sandbox `:831-878`; §15 Vault (`subs/data/<backend>/<accountId>`), §19, §20.
`docs/research/2026-09-subscriptions/p3-design.md` §11 (`:1457-1575`) is the port's contract:
it matches the code, the Z.ai adapter needs no contract change.

## 3. Pool, windows, probes, pauses: what still applies

A GLM Coding Plan key is an «account» of the pool: one row of `subscription_accounts`, one
Vault secret, its own windows and slots. Several keys = a pool, as now.

| Mechanism | Where | Plan with quotas |
| --- | --- | --- |
| Pool of accounts, one binding per task, one rebind | `pool.ts:221-255`, `turn-credentials.ts:334-350` | Applies |
| Turn slots (`max_concurrent_turns` 1–8) and request slots (`max_concurrent_requests` 1–16), ≤ 2 requests per key | `pool.ts:168,244`, `store.ts:212-213,250-256` | Applies; the plan's real concurrency is unknown 5 |
| Windows `5h/week/month` with `usedPct` and `resetsAt`; unknown = no admission; new task needs 10 % of `5h` | `pool.ts:109-144`, `store.ts:718-748` | Applies **if readable** (fork below) |
| Probe on demand: unknown windows (issue and admission), after `auth/account_risk/region/unconfirmed_block`, after an exhaustion without a reset time | `pool-health.ts:137-155,167-258`, `turn-credentials.ts:151-158`, `server.ts:679-697` | Applies. No periodic probe exists: between probes `usedPct` does not move (no headers), so exhaustion is learned from the provider's refusal — `classify` must recognise it |
| Cooling until a window resets (+60 s), 1 h when no reset is known | `store.ts:551-569`, `pool-health-store.ts:226-245` | Applies |
| Transient pauses 30/60/120 s in memory | `pool-health.ts:118-126` | Applies (overload, rate limit) |
| Usage breaker: 3 completed calls without usage → 15 min, one trial call | `store.ts:266-273,514-529` | Applies |
| `needs_relogin` after a confirmed auth probe | `pool-health-store.ts:211-219`, `pool-health.ts:248` | Applies: a revoked or rotated key → operator `--relogin` with the new key |
| `suspended` after a confirmed risk probe, 24 h hold of a bound task | `pool-health-store.ts:211-219`, `pool.ts:236-241` | Applies if the adapter can tell an expired/blocked plan (e.g. code `1113` on the coding path — not measured) |
| Region block of the whole egress with a 10-minute recheck | `egress-probe.ts:126-146`, `pool-health.ts:212-218` | Mechanism applies; whether Z.ai ever answers a region refusal is unknown |
| 402 «payment» pauses and suspension after three | `pool-health.ts:108-117`, `pool-health-store.ts:247-281` | Kimi's membership check; inert unless Z.ai answers 402 |
| Credits balance warning | `pool-health.ts:133-136`, `pool-health-store.ts:197-210,283-296`, `store.ts:546-549` | Codex only |
| `plan_changed` suspension | `pool-health-store.ts:192-196` | Inert while the probe returns `plan: null` |
| Scheduled refresh, refresh on 401, `refresh_ambiguous`, `vault_write_pending`, `refresh_region`, «expired access = pause», provider revocation by the role, pinned rotation in the credential cache | `refresher.ts`, `server.ts:760-792`, `store.ts:262-265,729-733`, `pool.ts:96`, `turn-credentials.ts:452-464`, `credentials.ts:185-223` | **OAuth only** |

Fork on windows:

- **A — the plan's quota is readable** by a content-free GET on `api.z.ai` (candidate from the
  public usage plugin of Z.ai: `/api/monitor/usage/quota/limit`; not confirmed with the key).
  Then `probe` maps it to `LimitWindow[]`, `windowsFromHeaders` returns null, and nothing in
  generic code changes. The probe must itself turn the HTTP-200 envelope into `auth`
  (`{code:401}` measured for an invalid key) and must send `accept-encoding: identity`.
- **B — no readable quota.** `device-login.ts:48-49` refuses the import (probe not `ok`),
  `pool.ts:114` never selects the account, `store.ts:737` never admits. The replacement then
  needs a port extension (a backend that declares «no window reports») and changed cases in
  `pool.ts readiness`, `store.ts accountRefusal` and `pool-health-store.ts probe`, with
  exhaustion handled only by refusal and cooling. This is the only place where the single
  provider could force a change of generic gateway logic.

## 4. Where the plan's key lives and who reads it

- Vault KV v2, mount `subs/`, path `subs/zai-coding/<accountId>` (`turn-key.ts:30-32`), one
  field `credential` holding the adapter's JSON (`credentials.ts:34-40`), `max_versions=1`,
  `cas_required`. SQL keeps only `credential_refs.vault_path` + `key_version` and
  `subscription_accounts.credential_version`.
- Written by the operator command with a `subscriptions-writer` token (create/update, cannot
  read back): import with CAS 0 (`login.ts:239`), relogin with the current version
  (`login.ts:272-320`). The key enters through stdin or hidden input (`cli.ts:367`), never
  through `.env` (rule 2).
- Read only by the role `llm` under AppRole `llm-subscriptions` (`subs/data/*` read, update):
  `credentials.ts:135-184` for generation and probes. `core` has `turns/*` only; web, mcp,
  runner, the sandbox VM and `egress-1` have no path to `subs/`. The proxy tunnels TLS and
  never sees the key.
- Destroyed by `subscriptions:retire --finalize --console-revoked` with a `subscriptions-admin`
  token after the operator revoked the key in the Z.ai console (`retire.ts:152-220,303-314`).
- No policy file changes: all three policies are written on `subs/*`.

## 5. What `issue` requires before it gives a turn key, and how B13 satisfies it

`GatewayTurnCredentials.issue` (`turn-credentials.ts:141-173`), checks in order:

| # | Requirement | Code | Stand B13 (`verify-llm-gateway.mjs`) |
| --- | --- | --- | --- |
| 1 | The task holds the site lease for a turn at this epoch; the task's workspace equals its site's workspace | `:575-593` | Creates workspace, site, task `running`, lease epoch 1 (`:371-399`) |
| 2 | An open assignment matching session, epoch and deadline — only in the product composition (`requireAssignment`) | `:675-702`, `llm.module.ts:84` | The stand's core worker builds the source without it |
| 3 | No earlier key for (task, turn, epoch), or the same one is returned | `:298-303` | Checked by a repeated `issue` (`:424-427`) |
| 4 | **Profile**: driver row enabled; provider with `slug = grant.backend`, `kind = 'subscription'`; model with `slug = grant.modelSlug`, enabled, `provider_model_id` set, `model_class = grant.modelClass`, `reserve_output_tokens > 0`; class equals the task's class | `:390-402` | Seeds, then `llmProvider.update({enabled:true})`, `llmModel.update({enabled:true, providerModelId, reserveOutputTokens:1024})` (`:325-333`), `agentDriver.updateMany({enabled:true})` (`:356-359`), task `modelClass:'standard'` |
| 5 | **Clearance**: only for `data_class = 'client'` — a `cross_border_clearances` row of this provider, not revoked, `transfer_allowed_from ≤ today (Moscow)` | `:403-410` | Workspace `dataClass: 'synthetic'` (`:371-373`), no clearance needed |
| 6 | **Rate**: a `llm_model_prices` row with `effective_from ≤ now`, else `LLM_PRICE_MISSING` | `:411-415` | Inserts a synthetic rate 10/30 ₽ per 1M, VAT 0.22 (`:334-343`) |
| 7 | **Budget**: `budgetRub` ≤ the attempt ceiling (class ceiling, or hold − fee over markup on pay-as-you-go) and ≥ the first-call reserve | `:630-674`, `budget.ts:173-186` | `budgetRub: '135.00'`, class `standard`, no pricing rule |
| 8 | **Account**: under the pool lock of the backend, among accounts of this provider **and** `driver_id = grant.driverId`: enabled, `credential_version > 0`, not revoked, `status active`, `health ok`, no retirement request, windows known with headroom, a free turn slot; the task's binding uses the same driver | `:418-492`, `pool.ts` | Account from `subscriptions:login` (Vault write + `health ok`), then `subscriptionAccount.update({enabled:true, limitWindows:[{5h,10 %,+1 h}], headroomPct:'90'})` (`:344-354`) — the stand writes the windows by hand before the first probe |
| 9 | Unknown windows → one control probe through the role `llm`, then reselect | `:151-158` | `core` worker gets `llmControlUrl` (`:366-369`) |
| 10 | Vault write-once `turns/t_<task>_<turn>_<epoch>`, then the second transaction creates `llm_keys` and the binding | `:194-232`, `:309-380` | AppRole `core` with `core-turns` (`stack.mjs:337-359`) |

For Z.ai on the stand: the same steps with a third backend row, `driverId: 'opencode'`, the
model's `provider_model_id = 'glm-5.3'`, a synthetic rate and the fake's quota answer. In the
product the rate is the owner's quarterly decision (no GLM rate exists), the clearance for
Z.ai does not exist, so only `synthetic` workspaces can get a key.

## 6. Smallest set of product changes for the replacement (Codex and Kimi still present)

1. `packages/domain/src/ports/llm-backend.ts:4` — add the id (+ `llm-backend.test.ts`).
2. `packages/llm-backends/src/zai-coding/` — new adapter (backend, body, errors, stream, usage,
   fixtures, tests); `src/index.ts:3-8` — register.
3. `apps/orchestrator/src/subscriptions/cli.ts:13,158-179,184` — import entry (driver
   `opencode`, slots) and help text (+ `cli.test.ts`).
4. `packages/db/prisma/seed/data.ts:191-247` — provider and model rows (+ `data.test.ts`). No
   schema change, no migration. Enabling `opencode` in an existing database: operator SQL or
   one small data migration.
5. `infra/sandbox/gateway.mjs:10-20,67-70` — route and, if needed, OpenCode headers (+ its two
   test files).
6. Egress allowlists: `infra/egress/env.example:5`, `infra/dev/llm-verify/egress.mjs:19`,
   `infra/dev/llm-verify/compose.yml:54`, `infra/dev/llm-verify/certificates.mjs:22`,
   `infra/app/verify/compose.llm.yml:49`.
7. `.env.example`, `turbo.json`, `infra/app/verify-llm-app.mjs:344-345` — the new override
   variable.
8. Stand: `fake-subscriptions.mjs`, `verify-llm-gateway.mjs`, `verify-llm-gateway-drivers.mjs`
   — third backend through the same scenarios.
9. Tests that pin the lists and change with them: `packages/db/prisma/seed/data.test.ts:192`
   (seed slugs equal `llmBackendIds`), `apps/orchestrator/src/config/llm-config.test.ts:93-96`
   (`providerOrigins`), `packages/domain/src/ports/llm-backend.test.ts`,
   `apps/orchestrator/src/subscriptions/cli.test.ts`.
10. Outside the gateway side, needed for a turn but mapped elsewhere: the OpenCode driver
   (`packages/agent-drivers/src/opencode.ts` — `prepare` and `command` throw «not implemented»),
   `ENABLED_AGENT_DRIVERS` (`apps/orchestrator/src/drivers/drivers.module.ts:9`), the sandbox
   image.

Unchanged for the replacement: `server.ts`, `store.ts`, `credentials.ts`, `egress.ts`,
`egress-probe.ts`, `pool-health*.ts`, `refresher.ts`, `llm-app.module.ts`, `llm-config.ts`,
`turn-credentials.ts`, `turn-key.ts`, `login.ts`, `device-login.ts`, `retire.ts`,
`pool.ts`, `budget.ts`, every Vault policy, `infra/app` compose, firewall and preflight,
`infra/egress/llm-egress.mjs` — under fork A and with generation errors on HTTP statuses.

## 7. What becomes dead once Codex and Kimi are gone

Code:

- `packages/llm-backends/src/openai-chatgpt/**` and `src/kimi-code/**` with fixtures and tests;
  `src/data-url.ts` if the Z.ai policy admits no images.
- Port (`llm-backend.ts`): `refresh?`, `login?`, `revoke?`, `RefreshOutcome`, `DeviceLogin*`;
  `creditsBalance` in `ProbeResult` and `LimitWindowSnapshot`; `windowsFromHeaders` and
  `responseHeaders` stay but always answer null / empty; `CredentialMetadata` is four nulls.
- Role `llm`: `refresher.ts` whole (rotation `:243-756`, scheduled `tick`, `retire` through
  `revoke`) with `refresher*.test.ts` and `scripts/verify-refresh-worker.mjs`;
  `MutableCredentialSource.install/commit/versionOf` (`credentials.ts:17-28,185-223`);
  refresh-and-retry on 401 (`server.ts:760-792`) and `GatewayLifecycle.refresh`; the refresh
  and retire timers and the 26-second rotation wait at shutdown
  (`llm-app.module.ts:67-77,164-167,186,196-199,214-220`); credits and `plan_changed`
  (`pool-health-store.ts:190-210,283-296`, `pool-health.ts:133-136`, `store.ts:546-549`); 402
  payment pauses (`pool-health.ts:108-117`, `pool-health-store.ts:63,247-281`);
  `refresh_ambiguous` branches (`store.ts:262-265,729-733`, `pool.ts:96`);
  `EXPIRED_ACCESS_WAIT_MS` (`turn-credentials.ts:95-96,452-464`); the `authNeedsRelogin`
  switch (always true).
- Operator commands: device flow (`device-login.ts:52-93`), `saveIssuedCredential` /
  `UnsavedSubscriptionLogin` revoke branch, the device-code terminal in `secret-input.ts`,
  `deviceUri` and the device branch in `cli.ts:356-372`; in `retire.ts` the stage
  `provider_revocation_pending` and the refusal `automaticRevocation` become unreachable.
- `infra/sandbox/gateway.mjs`: both old paths, six Codex request headers, the lite header and
  its check, `x-msh-*` passthrough, `x-codex-turn-state` in responses.
- Egress and env: hosts `chatgpt.com`, `auth.openai.com`, `api.kimi.ai` in every allowlist,
  alias and SAN; `LLM_BACKEND_URL_OPENAI_CHATGPT`, `LLM_AUTH_URL_OPENAI`,
  `LLM_BACKEND_URL_KIMI_CODE` (`.env.example:43-45`, `turbo.json:18-20`,
  `verify-llm-app.mjs:344-345`).
- Stand: the Codex/Kimi/OAuth half of `fake-subscriptions.mjs`, `record-proxy.mjs`,
  `local-spike.mjs`, `backend-adapter.mjs` and their tests (P3.0 recon of Codex).

Data (new migration, never an edit of an applied one):

- Seeds of the two providers and four models go; rows in existing databases stay for history
  and are switched off by a data migration.
- Columns that only OAuth filled: `subscription_accounts.credential_expires_at`,
  `credential_refreshed_at`, `refresh_finished_at`, `refresh_failures`, `credits_seen`,
  `external_account_id` (+ its partial unique index). Dropping them is an optional contract
  migration; `refresh_started_at` is still the marker of an unfinished import
  (`login.ts:234,311`).

What stays with one provider and one shell: the port and the adapter boundary (rule 8), the
pool with windows, probes, cooling, breaker and slots, turn keys and their sweeper, the budget
and usage accounting, the mTLS egress with its byte probe and region block, `subs/` with its
three policies, key import with relogin, retirement with console revocation.

## 8. Unknowns that decide details of the design

1. **Quota endpoint of the plan.** Existence, path, authentication form and answer shape of a
   content-free «usage» request on `api.z.ai` for a GLM Coding Plan key: which windows (5 hours,
   week, month), percentage or counters, reset time format, whether it names the plan. Needs
   one keyed GET. Decides fork A or B.
2. **Coding-path errors other than auth**: exhausted 5-hour or weekly quota (status, `error.code`,
   whether a reset time is given), concurrency or rate limit, unknown or not-included model,
   content refusal, too long prompt, expired plan — and whether any of them comes as HTTP 200
   JSON or inside an already started SSE stream. Decides `classify`, the stream inspector and
   the conditional change in `server.ts:803-808`.
3. **OpenCode against the gateway** (the protocol probe's subject, needed by the adapter):
   headers and user agent it sends; exact body fields; whether every request is streamed;
   whether auxiliary calls (session title, compaction) use another model — the policy admits
   only the profile's model (`body.ts:124` pattern) and each key carries one model; how it
   reacts to 400 / 429 / 503 with `retry-after` and to an in-stream error — the refusal shapes
   must end a turn on final refusals instead of being retried.
4. Reasoning control on the coding chat path (`thinking`, effort levels) and what
   `reasoning_effort` of a profile means for GLM; whether `prompt_cache_key` is accepted there.
5. Concurrency the plan allows per key (turns and parallel requests) — the numbers for the
   `imports` entry.
6. Whether `api.z.ai` is reachable and stable from a Russian address without the node, and
   whether Z.ai restricts by region — not established by the code or by today's probes.
7. Accounting rate for GLM models and the recipient (legal entity, country) for the 152-ФЗ
   gate — owner and lawyer; without a rate no key is issued.
