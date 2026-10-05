# OpenCode CLI 1.18.34 against GLM on Z.ai (GLM Coding Plan) — protocol notes

Probe of 04.10.2026, 22:43–23:35 MSK. Everything below was observed in real runs unless marked
**(from the binary)** — read out of the CLI executable, not exercised — or **(unknown)**.
Paths are relative to `scratchpad/glm/` (`G`): samples in `samples/<NN-name>/`, run outputs in
`opencode-cli/runs/<NN-name>/` (`stdout.txt` = the CLI's JSON events, `stderr.txt`, `exit.txt`,
`files.txt`, `sink.jsonl` = other hosts the CLI tried), CLI help in `opencode-cli/help/`, pieces of the
executable in `opencode-cli/strings/`, configs used in `opencode-cli/configs/`.

## 0. Short answers

- **It works through a gateway.** `opencode run --format json` in a read-only, cap-dropped container
  (uid 10001, internal network, no DNS to the world) completed tool turns against `glm-5.3` with a custom
  base URL and a dummy key; the host proxy put the real key in. Runs 31, 33, 34, 35, 36.
- **Best form: OpenAI-compatible chat completions**, `POST {base}/chat/completions` on
  `https://api.z.ai/api/coding/paas/v4`. It is what the CLI's own built-in provider `zai-coding-plan`
  uses, it returns real HTTP statuses on errors, and usage arrives in the last stream chunk. The
  Anthropic form and the Responses form also complete a tool turn with this key (section 9).
- **Session continues** with `--session <id>`; the whole state is `opencode.db` (+ `-wal`). A fresh home
  holding only that database resumes with full history (runs 41, 51). `export`/`import` works too (55).
- **Remote MCP works**; tools reach the model as `<server>_<tool>` (`raditi_site_info`, `raditi_wp_rest`).
- **Structured final result**: `opencode run` has no schema option. Stating the product's JSON Schema
  in the agent prompt gave 3 valid objects in 3 turns (strict `turnResultSchema`). The headless server
  API has a real `format: json_schema` (forced tool `StructuredOutput`) and it worked once (run 49).
- **Three things the gateway and driver must not get wrong** (section 8): an HTTP 200 non-stream error
  body makes the CLI resend without any pause (2 320 requests in 100 s); a `retry-after` header is obeyed
  up to 24.8 days; a tool call that needs an `ask` permission ends the turn with exit code 0 and no result.
- **Plan**: `GET https://api.z.ai/api/monitor/usage/quota/limit` answers with the plan level (`lite`)
  and two credit windows — 2 000 per 5 hours and 10 000 per week — with reset times. No quota headers on
  model responses.

## 1. The package

| Fact | Value | Evidence |
| --- | --- | --- |
| npm package | `opencode-ai@1.18.34`, 4 files, 7 865 bytes: a launcher stub and `postinstall.mjs` | `opencode-cli/registry-opencode-ai-1.18.34.json` |
| integrity | `sha512-9WUS2T0t4HHDVzXvuwTHF0nvhXvZ9mQ0r+ozCvKdJu0LVoQpOzqAW4qWTC3ygNc5Oedcc7j+Oct24JYlQYnySA==` | same |
| platform binary | `opencode-linux-arm64@1.18.34`, one file `bin/opencode`, 185 116 816 bytes, glibc, needs only libc/libpthread/libdl/libm | `registry-opencode-linux-arm64-1.18.34.json`, `ldd` in the build |
| integrity | `sha512-ZSjqcH0MEbAzLEmkRC9Aop1PbWZxe2NuKONAE/x8MRQdjKdOepX7M50UpjbsNoiLMkP584Z98Mg4a42fJhouvA==`; sha256 of the binary `415487fcd9b3f06addd6877435783f3d5a236c029066b0dd6597d64980b15351` | same |
| other platforms | 12 optional packages; `-musl` ones carry `libc: ["musl"]`, so npm on Debian installs only the glibc one | registry metadata |
| lock file | `opencode-cli/package-lock.json` (lockfileVersion 3, made by npm 11.19.1 of Node 26.10 with `npm install --package-lock-only --ignore-scripts`) | built in the image |
| install | `npm ci --ignore-scripts` → "added 2 packages" | build log |
| runtime | Bun 1.3.14 single-file executable; `--version` prints `1.18.34` | `help/01-commands-help.txt`, user-agent |

**`--ignore-scripts` leaves `node_modules/opencode-ai/bin/opencode.exe` a shell stub that prints
"postinstall script was not run" and exits 1.** `postinstall.mjs` only hard-links the platform binary
onto that stub (and, if the platform package is missing, runs `npm install` — a network call). The
product must call the binary directly: `node_modules/opencode-linux-<arch>/bin/opencode`
(`opencode-linux-x64` on amd64; x64 without AVX2 needs `-baseline`), or link it in the Dockerfile.

The image was the local `raditi-p5verify-sandbox:local` plus that install
(`opencode-cli/build/Dockerfile`). It is removed; a rebuild downloads the two tarballs again.

## 2. Headless run

```
opencode run --format json [--session <id>] [--agent <name>] [--title <text>] [--variant low|high|max] [-m provider/model] < prompt
```

- **Prompt through stdin.** A 400 076-byte Cyrillic prompt arrived whole as one user message (run 51,
  `bodyBytes` 424 290). A prompt passed as an argument is wrapped in double quotes when it has spaces
  (sample 31/01: the user message starts with `"\"Do exactly…`), and is bound by the kernel's argument limit.
- `--title` skips the title request (one LLM request fewer on the first turn). Without it the first turn
  sends a second request: system "You are a title generator…", two user messages, no tools, no `thinking`,
  `max_tokens` 32000, model = `small_model` (falls back to the main model) — sample 31/02.
- `--agent` picks an agent from the config; `default_agent` does the same.
- `--variant` sets the reasoning effort, but only for a model that has variants (section 4).
- `--thinking` added no event in `--format json` (run 52).
- No flag of `run` takes an output schema. `--auto` approves `ask` permissions ("dangerous").
- Other commands used: `opencode session list --format json`, `opencode export <id>`,
  `opencode import <file>`, `opencode db "<sql>"`, `opencode db path`, `opencode debug config|paths|info`,
  `opencode models`, `opencode mcp list`, `opencode serve` (HTTP API, OpenAPI at `/doc`, 162 paths).

**stdout, one JSON object per line** (runs 31, 34; the repository fixture `fixtures/opencode.jsonl` has
the same shapes):

| `type` | Payload | When |
| --- | --- | --- |
| `step_start` | `sessionID`, `part{type:"step-start", id, messageID, snapshot?}` | before each model request that produced something; also once per retry of a cut stream |
| `tool_use` | `part{type:"tool", tool, callID, state{status:"completed"\|"error", input, output\|error, metadata, title, time}}` | after a tool finished; bash has `metadata.exit`, edit has `metadata.diff` |
| `text` | `part{type:"text", text, time}` | a finished text block; the final message is the last one before `step_finish` with `reason:"stop"` |
| `step_finish` | `part{type:"step-finish", reason, tokens{total,input,output,reasoning,cache{read,write}}, cost}` | `reason`: `tool-calls`, `stop`, `unknown` (seen), `length`/`content-filter`/`error` (from the binary) |
| `error` | `error{name:"APIError", data{message, statusCode?, isRetryable, responseHeaders?, responseBody?, metadata{url\|code}}}` | after retries are exhausted; carries the gateway URL and the raw response body |

Token mapping (sample 31/01 against run 31): `input` = `prompt_tokens − cached_tokens` (7105 − 6784 =
321), `cache.read` = `cached_tokens`, `output` = `completion_tokens − reasoning_tokens` (94 − 54 = 40),
`reasoning` = `reasoning_tokens`, `total` = `total_tokens`, `cache.write` always 0, `cost` 0. The
existing `parseOpencodeEvent` already adds reasoning back to output.

**Exit codes**: 0 after a finished turn; 1 after an `error` event (401 at once, 5xx/429/network after
retries); 1 with nothing on stdout and a plain-text line on stderr when the config is invalid
(`bad file reference: "{file:…}" … does not exist` — seen once; that output was overwritten by the repeat of
run 45-closed-port); **0 with no final
text** when a permission request was auto-rejected (section 8). SIGTERM ends it promptly (`timeout`
returned 124 after 101 s of a 100 s limit).

Timing: 2–3 s of start-up; a two-request turn took 7–11 s.

## 3. Configuration and directories

Read at start, in order: `~/.config/opencode/config.json`, `opencode.json`, `opencode.jsonc`
(stderr of run 31), then project files unless disabled, then `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`.
`{env:NAME}` and `{file:/abs/path}` are substituted in values. `opencode debug config` prints the result
with `apiKey` and MCP `Authorization` as `***` (run 53).

Directories with `HOME=/agent-home/opencode` (`opencode debug paths`, XDG variables move them **(from
the binary: standard XDG)**):

| Path | Holds | Written during a run |
| --- | --- | --- |
| `~/.config/opencode/` | `opencode.json`, `AGENTS.md`; the CLI adds `.gitignore` and tries an npm install here | only if writable |
| `~/.local/share/opencode/opencode.db`, `-wal`, `-shm` | SQLite (WAL mode): sessions, messages, parts, projects, todo, … 21 tables | yes |
| `~/.local/share/opencode/log/opencode.log` | INFO log, appended | yes |
| `~/.local/share/opencode/snapshot/<project>/<worktree>/` | a bare git repository tracking the work tree (undo) | only with `snapshot` on (default) |
| `~/.local/share/opencode/auth.json` | provider keys saved by `providers login` | never in these runs |
| `~/.local/share/opencode/repos`, `tool-output/` | clones for references; truncated tool output | empty here |
| `~/.cache/opencode/bin` | downloaded ripgrep and LSP servers | empty: `rg` is on PATH |
| `~/.cache/opencode/models.json` | the fetched model catalogue (5-minute TTL) | not with the fetch disabled |
| `~/.local/state/opencode/locks/` | lock directories of the npm install | only when the config dir is writable |
| `/tmp/opencode` | scratch | yes |

Works with a read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, tmpfs `/tmp`, uid 10001.

Settings that matter (schema in `strings/ctx-config-schema.txt`, `ctx-provider-config.txt`,
`ctx-permission-config.txt`):

| Key | Use |
| --- | --- |
| `model`, `small_model` | `provider/model`; set both, or the title and compaction requests pick a model themselves |
| `provider.<id>` | `npm` (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, `@ai-sdk/openai` are inside the binary — no download), `options{baseURL, apiKey, headers, timeout, headerTimeout (300 s), chunkTimeout (300 s), setCacheKey}`, `models.<id>{limit{context,output}, reasoning, tool_call, interleaved, options, headers, variants}` |
| `enabled_providers` | only these exist; without it the provider `opencode` with free models is listed even with no key (`help/02-offline-debug.txt`); with it `opencode models` shows one line (run 53) |
| `mcp.<name>` | `{type:"remote", url, headers, oauth:false, timeout (default 5 000 ms), enabled}` |
| `agent.<name>` | `{mode:"primary", prompt, permission, model, …}`; `prompt` replaces the CLI's 9.5 k-character base prompt |
| `permission` | `allow` / `ask` / `deny` per tool or per pattern: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, lsp, doom_loop, skill`, plus any tool name pattern (`raditi_*`) |
| `experimental.continue_loop_on_deny` | keep going after a denied call (section 8) |
| `autoupdate: false`, `share: "disabled"`, `snapshot: false`, `lsp: false`, `formatter: false`, `plugin: []` | switch-offs; LSP and formatters are already off by default (stderr of run 31) |
| `compaction.auto` | automatic summarising request when the context fills (default on) **(from the binary)** |
| `instructions` | extra instruction files |

Environment flags (all in `strings/env-names.txt`, definitions in `strings/ctx-flags.txt`):
`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`,
`OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_PURE` (= `--pure`),
`OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_SHARE`,
`OPENCODE_DISABLE_AUTOCOMPACT`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`,
`OPENCODE_PERMISSION`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_DB`, `OPENCODE_MODELS_URL`,
`OPENCODE_MODELS_PATH`, `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, `OPENCODE_SERVER_PASSWORD`,
`OTEL_EXPORTER_OTLP_ENDPOINT`.

**The site repository is hostile input.** With no flags the CLI merged the repository's `opencode.json`
(username, `instructions`, an MCP server), loaded `.opencode/agent`, `.opencode/command`,
`.opencode/skill`, **imported and executed `.opencode/plugin/planted.js`**, went to
`registry.npmjs.org`, and wrote `.opencode/.gitignore` into the repository (run 32, 220 s because of the
registry waits). With `OPENCODE_DISABLE_PROJECT_CONFIG=1` none of that happened and the repository's
`AGENTS.md`, `CLAUDE.md` and `PLANTED.md` did not reach the system prompt (sample 33/01: only the global
`AGENTS.md` marker is present). `OPENCODE_PURE=1` alone stops the plugin but still merges the project
config.

**System prompt is rebuilt on every request** from the current config: agent prompt (or the base
prompt), one line naming the model, an `<env>` block (work dir, git yes/no, platform, date), then
`Instructions from: <path>` + the global `AGENTS.md` (sample 34/09). Nothing of it is stored in the
session, so a resumed turn gets the current instructions without any repetition trick.

**Credentials.** With `apiKey: "{env:RADITI_LLM_KEY}"` the bash tool inherits both variables and can read
them from `/proc/<pid>/environ` of the CLI as well (run 31, `envcheck.sh` output: `own env names:
OPENCODE OPENCODE_PID OPENCODE_PRINT_LOGS RADITI_LLM_KEY RADITI_MCP_TOKEN`). With
`{file:/run/raditi/secrets/llm}` and `Bearer {file:/run/raditi/secrets/mcp}` the CLI started with
neither variable in its environment and both dummy tokens reached the proxy and the MCP stub (run
45-file-secrets-plain). The files are read once per process: named pipes that deliver each value a single
time worked the same (run 45-file-secrets-fifo). A missing file is a fatal config error.

## 4. What it sends to the provider — chat completions form

Every sample `samples/31…36/*-llm-post_chat_completions.json` holds the full request body, the headers
and the raw SSE.

**Path**: `POST {baseURL}/chat/completions`. Nothing else: no `/models`, no usage call.

**Headers**: `authorization: Bearer <apiKey>`, `content-type: application/json`,
`user-agent: opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`,
`x-opencode-session-id`, `x-session-affinity`, `x-session-id` (all three = the session id),
`accept: */*`, `accept-encoding: gzip, deflate, br, zstd`, `connection: keep-alive`. No cookies.

**Body fields** (main loop): `model` ("glm-5.3"), `max_tokens` (32000 — the CLI's own cap, the model
allows 131 072), `thinking: {type:"enabled", clear_thinking:false}`, `messages`, `tools`,
`tool_choice: "auto"`, `stream: true`, `stream_options: {include_usage: true}`; with a variant also
`reasoning_effort: "low"|"high"|"max"`. No `temperature`, `top_p`, `user`, `response_format`.
`thinking` is added for a custom provider id too (sample 31/01), i.e. by model, not by provider.

**Messages**: `system` (one string), `user` (string), `assistant` with `content`, `tool_calls[{id,
type:"function", function{name, arguments}}]` **and `reasoning_content`** (the model's earlier
reasoning is sent back), `tool` with `tool_call_id` and string `content`.

**Tools** — `{type:"function", function{name, description, parameters}}`, parameters carry `$schema`,
`type`, `properties`, `required`; no `strict`. Default set (10): `bash(command, timeout, workdir)`,
`edit(filePath, oldString, newString, replaceAll)`, `glob(pattern, path)`, `grep(pattern, path,
include)`, `read(filePath, offset, limit)`, `skill(name)`, `task(description, prompt, subagent_type,
task_id, command)`, `todowrite(todos)`, `webfetch(url, format, timeout)`, `write(content, filePath)`.
A tool denied as a whole (`"webfetch": "deny"`) is not declared (7 tools in sample 33/01). MCP tools are
added as `raditi_site_info`, `raditi_wp_rest` with the server's description and input schema unchanged
(sample 34/09).

**Stream** (`content-type: text/event-stream;charset=UTF-8`), each line `data: {id, created,
object:"chat.completion.chunk", model, choices:[{index:0, delta}]}`:

1. reasoning: `delta {role:"assistant", reasoning_content:"…"}`;
2. text: `delta {role:"assistant", content:"…"}`;
3. each tool call in **one** chunk with the complete arguments string: `delta {tool_calls:[{id:
   "call_<24 hex>", index, type:"function", function{name, arguments}}]}`; two calls in one answer were
   executed both (sample 31/01: `bash` and `write`);
4. last data chunk: `choices[0].finish_reason` (`tool_calls` | `stop`) with `delta {role, content:""}`
   **and `usage`** `{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details{cached_tokens},
   completion_tokens_details{reasoning_tokens}}`;
5. `data: [DONE]`.

`completion_tokens` includes `reasoning_tokens`. `cached_tokens` was large from the first request
(6 784 of 7 105) and zero on some (sample 43-variant-low).

**Response headers** from Z.ai: `x-log-id`, `x-request-id`, `ga-traceid`, `set-cookie: acw_tc=…`
(HttpOnly, 1800 s), `vary`, `alt-svc`, `date`. No rate-limit or quota header on any answer.

**Reasoning effort**: built-in `zai-coding-plan/glm-5.3` + `--variant max|low` → `reasoning_effort` in
the body; low gave 0 reasoning tokens (samples 43-variant-max, 43-variant-low). A custom provider id
ignores `--variant` silently (43-variant-custom-high) unless the model declares `variants`.

**Resume**: the request repeats the whole history from the database (sample 33/01: 7 messages, the
first turn's tool calls and reasoning included).

## 5. MCP (remote, streamable HTTP)

Sample 34: one connection per process, at start.

| Step | Request | Notes |
| --- | --- | --- |
| 1 | `POST /mcp` `initialize` `{protocolVersion:"2025-11-25", capabilities:{roots:{}}, clientInfo:{name:"opencode", version:"1.18.34"}}`, id 0 | headers: `authorization` (from config), `accept: application/json, text/event-stream`, `content-type`, `user-agent: opencode/1.18.34` |
| 2 | `POST` `notifications/initialized` | from here also `mcp-protocol-version: 2025-11-25` and `mcp-session-id` when the server issued one |
| 3 | `GET /mcp` (`accept: text/event-stream`) | 405 is accepted |
| 4 | `POST` `tools/list`, id 1 | |
| 5 | `POST` `tools/call` `{name, arguments, _meta:{progressToken:<id>}}` | the answer was plain JSON |
| 6 | `POST` **`notifications/cancelled`** `{requestId, reason:"AbortError: The operation was aborted."}` | sent after **every finished** call, right after its answer |

No `DELETE` at exit. With `oauth:false` there was no OAuth discovery. The default request timeout is 5 s
(`timeout`, or `experimental.mcp_timeout`) **(from the binary; the runs set 20 s)**. The tool result reaches the model as the text content.

## 6. Structured final result

- **Through the prompt** (as the Kimi driver does): agent prompt = instructions + "End the turn with one
  JSON object, without markdown fences, matching this JSON Schema…" + `turnResultSchema` as JSON Schema
  (`configs/d-result.json`). Three turns in one session — a file created, a read-only question through
  MCP, a request to delete all pages — each ended with one `text` event that parses and passes
  `turnResultSchema` strictly: `change_type` content/none/none, `needs_approval` false/false/true, Russian
  `client_message` (`validate-results.mjs`, runs 35, 36-d2, 36-d3). Three of three is a small sample.
  `change_type` for a file in the repository came back `content`, not `code` — the wording of the
  contract needs to define the two for this model.
- **Through the server API**: `POST /session/{id}/message {agent, parts, format:{type:"json_schema",
  schema, retryCount}}` adds a tool `StructuredOutput` whose parameters are the schema (with
  `minLength`/`maxLength` as given), appends "You MUST use the StructuredOutput tool…" to the system
  prompt and sends **`tool_choice: "required"`** on every request of that turn; Z.ai accepted it. The
  answer's `info.structured` held the object (run 49, sample 49/05). It needs `opencode serve` and an
  HTTP client inside the sandbox. A request sent in the first moments after "server listening" hung until
  the client's own 300 s timeout (run 49-serve-timing); `curl -m 1` in a loop did not (run 48). The server
  warns that it is unsecured without `OPENCODE_SERVER_PASSWORD`.

## 7. Session files

After the first turn, default settings (run 31): `opencode.db` 249 856, `opencode.db-wal` 1 165 992,
`opencode.db-shm` 32 768, `log/opencode.log` 5 529, snapshot repository 148 KiB (21 objects), two lock
directories. With `snapshot:false` and a read-only config dir a fresh home holds only the database
triple and the log (run 38: db 4 096, wal 564 472).

- The CLI does not checkpoint at exit: the WAL keeps the data. `opencode db "pragma
  wal_checkpoint(TRUNCATE)"` emptied it (db 483 328, wal 0; run 40).
- **Restore**: a new home with only the checkpointed `opencode.db` resumed the session with all 16
  messages (run 41); `opencode.db` + `opencode.db-wal` without `-shm` resumed too (run 51).
- `opencode export <id>` → 25 735 bytes of JSON `{info, messages[{info, parts}]}` for a three-turn
  session; `opencode import <file>` in an empty home recreated the same id and the history (run 55).
- The session is bound to the project id (the root commit of the repository) and the directory
  `/workspace/repo`; both were the same on restore. Another repository root — **(unknown)**.
- The session row keeps running totals: `tokens_input`, `tokens_output`, `tokens_reasoning`,
  `tokens_cache_read`, `cost`.
- Whether a failed turn leaves its user message in the session history — **(unknown, not checked)**.
- The database holds every session of the home; one home per task keeps it small. The request storm of
  section 8 grew it to 15 MB and the log to 1.5 MB in 100 s.

## 8. Errors, cut stream, retries

| Answer of the "provider" | What the CLI did | Evidence |
| --- | --- | --- |
| 401 `{"error":{"code":"401","message":…}}` | one request, `error` event (`statusCode` 401, `isRetryable` false), exit 1 in 2 s | run 37-err-http401 |
| 500 JSON error | 6 requests in 73 s (pauses about 2, 4, 10, 20, 35 s), `error` event, exit 1 | run 37-err-http500 |
| 429 `{"error":{"code":"1113",…}}` | same: 6 requests in 68 s, exit 1 | run 37-err-http429 |
| stream cut after 900 bytes (socket destroyed) | 6 requests in 67 s, a `step_start` per attempt, `error` `{message:"Connection reset by server", metadata.code:"ECONNRESET"}`, exit 1 | run 39-err-cut |
| closed port | about 68 s of retries, `error` "Cannot connect to API…", exit 1 | run 45-closed-port |
| **HTTP 200, `application/json`, `{"code":401,"msg":…,"success":false}`** to a streaming request | **no error at all**: an empty step with `reason:"unknown"`, zero tokens, and the same request again at once — 2 320 requests in 100 s until killed | runs 39-err-json200, 39-err-json200-short |

Retry rules **(from the binary, `strings/ctx-retry.txt`)**: 5 retries, 2 s base, factor 2, 25 % jitter,
30 s cap when the answer has no headers; **`retry-after-ms` / `retry-after` are obeyed up to
2 147 483 647 ms**. Retried: `isRetryable` of the SDK (408, 409, 429, 5xx), any status ≥ 500, and any
error whose **message or body text** matches `429|500|502|503|504|524`, "rate limit", "too many
requests", "overloaded", "internal error", "server error", "try again later", "resource exhausted",
"connection refused", "timeout" and the like. So a final refusal is retried if its text merely contains
such a number or phrase.

Permissions in a headless run:

- `ask` → `! permission requested: edit (hello.txt); auto-rejecting`; the `tool_use` events have
  `status:"error"`, "The user rejected permission to use this specific tool call."; **the turn stops
  there: last `step_finish` has `reason:"tool-calls"`, no text, exit code 0, no further request**
  (run 47-permission-ask).
- a `deny` pattern with `experimental.continue_loop_on_deny: true` → the tool fails with "The user has
  specified a rule which prevents you…", the model is told and finishes normally (run 47-deny-continue).
  Without the flag — **(unknown, not run)**; the flag's own description says the loop stops.

What Z.ai itself answers on the coding endpoint (direct calls, samples 54): invalid key → **HTTP 401**
`{"error":{"code":"401","message":"token expired or incorrect"}}` for stream and non-stream; no key →
401 code `1001`; unknown model → 400 code `1211`; `max_tokens` out of range → 400 code `1210` (the 400s
come without a `content-type`). The HTTP 200 error objects were seen on `/api/v1` and on unknown paths
(earlier probe, samples 10, 14), not on this endpoint.

## 9. Provider forms with this key

| Form | Config | Request | Result |
| --- | --- | --- | --- |
| OpenAI-compatible chat completions, custom provider | `npm: "@ai-sdk/openai-compatible"`, `baseURL` → `…/api/coding/paas/v4` | section 4 | works; samples 31–36 |
| the CLI's built-in **`zai-coding-plan`** (catalogue snapshot inside the binary: `env ZHIPU_API_KEY`, same npm and address, 7 models, `glm-5.3` context 1 000 000, output 131 072, efforts low/high/max, `interleaved.field = reasoning_content`, cost 0) with `options.baseURL` and `options.apiKey` overridden | `provider."zai-coding-plan".options{…}`, `model: "zai-coding-plan/glm-5.3"` | identical body, plus working `--variant` | works with the catalogue fetch disabled; sample 42, `strings/builtin-zai-providers.json` |
| Anthropic messages | `npm: "@ai-sdk/anthropic"`, `baseURL` → `…/api/anthropic/v1` | `POST /messages`, `x-api-key`, `anthropic-version: 2023-06-01`; body `model, max_tokens, system[], messages, tools, tool_choice{type:"auto"}, stream`; the SDK adds `cache_control: ephemeral` | works; usage `input_tokens` (uncached), `output_tokens`, `cache_read_input_tokens`; no thinking was requested, reasoning 0; sample 44-form-e |
| Responses | `npm: "@ai-sdk/openai"`, `baseURL` → `…/api/v1` | `POST /responses`; body `model, input, max_output_tokens, store:false, include:["reasoning.encrypted_content"], prompt_cache_key:<session id>, tools, tool_choice, stream` | works; usage in `response.completed`; sample 44-form-g |

`https://api.z.ai/api/paas/v4` stays closed for this key (429 code 1113, earlier sample 21).

## 10. Plan limits

`GET https://api.z.ai/api/monitor/usage/quota/limit` with `Authorization: Bearer <key>` (the bare key
works too) — the CLI does not know this address; it is the one Z.ai's own usage plugin calls (samples
46-quota-limit-*):

```json
{"code":200,"msg":"Operation successful","success":true,"data":{"level":"lite","limits":[
 {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"currentValue":20,"remaining":1979,"percentage":1,"nextResetTime":1791154059203},
 {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":10000,"currentValue":20,"remaining":9979,"percentage":1,"nextResetTime":1791740593998}]}}
```

- Two windows: `unit 3 × number 5` = 5 hours with 2 000 credits, reset 2026-10-04T22:47:39Z;
  `unit 6 × number 1` = one week with 10 000 credits, reset 2026-10-11T17:43:13Z. Both started at the
  first use (about 17:45Z today), i.e. they are rolling from first use, not calendar. The meaning of the
  unit codes is read off the reset times.
- Consumption: 20 credits after my first 24 agent requests and the lead's earlier probes; 23 after 27;
  24 after 29; 25 after 30 and two refused requests. Roughly one credit per agent request of about 5 000
  prompt tokens (mostly cached); the formula is **(unknown)**. The value updated within seconds.
- `…/api/monitor/usage/model-usage?startTime=&endTime=` and `…/tool-usage` answer 200 with hourly
  arrays, all zeros for today (samples 46-model-usage, 46-tool-usage) — delayed or a different clock.
- What the API answers when a window is exhausted — status, code, body, `retry-after` — **(unknown)**:
  the quota was not exhausted. The canned 429 used here is the body of the closed pay-per-token endpoint.

## 11. Other destinations the CLI wants, and the switch for each

Recorded by a DNS/SNI sink that was the container's only resolver (`opencode-cli/sink-full.jsonl`); all
were refused.

| Destination | When | Switch | Checked |
| --- | --- | --- | --- |
| `models.opencode.ai` (`GET /api.json`, 10 s timeout, cache 5 min) | `opencode models`, start-up without the flag | `OPENCODE_DISABLE_MODELS_FETCH=1` (the snapshot in the binary is used; `OPENCODE_MODELS_PATH` gives a file) | yes: silent in every hardened run |
| `registry.npmjs.org` | background install of `@opencode-ai/plugin` into every config directory, about once a minute across runs; also dependencies of `.opencode/` in the repository | **make `~/.config/opencode` not writable** (the install returns at once when the directory is not writable); `OPENCODE_DISABLE_PROJECT_CONFIG=1` for the repository | yes: runs 38 and later are silent; no environment flag stopped it |
| `github.com` | download of ripgrep when `rg` is not on PATH | keep `ripgrep` in the image | yes: run 52-rg-check |
| GitHub releases of language servers | LSP | off by default; `lsp:false`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1` | not triggered |
| `api.github.com/repos/anomalyco/opencode/releases/latest`, npm | update check | `autoupdate:false`, `OPENCODE_DISABLE_AUTOUPDATE=1` | never seen in `run`, with or without the flags |
| `opncd.ai`, `api.opencode.ai`, `opencode.ai/zen` | sharing, console, the provider `opencode` | `share:"disabled"`, `OPENCODE_DISABLE_SHARE=1`, `enabled_providers` | not triggered |
| `mcp.exa.ai` | web search | `permission.websearch: "deny"`; needs `OPENCODE_ENABLE_EXA` anyway | not triggered |
| any URL | `webfetch` tool | `permission.webfetch: "deny"` removes the tool | yes |
| OTLP endpoint | telemetry spans | only with `OTEL_EXPORTER_OTLP_ENDPOINT` / `experimental.openTelemetry` | no telemetry host was ever requested |

With no network at all `--version`, `--help`, `debug`, `models`, `session list` work
(`help/02-offline-debug.txt`); a run reports the connection error after about a minute of retries.

## 12. Tables for the design

### What the driver must write and run

| Item | Content |
| --- | --- |
| Binary | `/usr/local/lib/raditi/agent-clis/node_modules/opencode-linux-<arch>/bin/opencode` — not the `opencode.exe` stub |
| `~/.config/opencode/opencode.json` | `model` and `small_model` = `<provider>/glm-5.3`; `enabled_providers: [<provider>]`; the provider with `options.baseURL` = the gateway's LLM path and `options.apiKey` = `{file:<secret>}`; `mcp.raditi {type:"remote", url, oauth:false, timeout, headers.Authorization: "Bearer {file:<secret>}"}`; `default_agent` + `agent.<name> {mode:"primary", prompt: platform instructions + result contract}`; `permission`: every tool `allow` or `deny`, never `ask` (`webfetch`, `websearch`, `task`, `skill`, `question`, `external_directory`, `doom_loop` → `deny`; `raditi_*` → `allow`); `experimental.continue_loop_on_deny: true`; `autoupdate:false`, `share:"disabled"`, `snapshot:false`, `lsp:false`, `formatter:false`, `plugin:[]` |
| Provider id | the built-in `zai-coding-plan` with overridden address and key gives the model limits and `--variant`; a custom id needs `models.<id>` with `limit`, `reasoning`, `tool_call`, `interleaved` and its own `variants` |
| Config directory | made read-only after the files are written (stops the npm lookups and the `.gitignore`) |
| Environment | `HOME`, `NO_COLOR=1`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_PURE=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_SHARE=1`; no credential in the environment |
| Secrets | the two files of `/run/raditi/secrets` referenced by `{file:}`; they are read once at start, so they can be removed (or be one-shot pipes) before the model's first command |
| Command | `opencode run --format json --agent <name> --title <fixed> [--variant <effort>] [--session <id>]`, prompt on stdin |
| Session id | `sessionID` of any event (`ses_…`); present on the `error` event too |
| Events | as `parseOpencodeEvent` already maps them; add: `error` with `data.responseBody`/`metadata.url` must not go to the client; `step_finish` with `reason:"unknown"` is a failure; exit 0 with the last step `tool-calls` and no text is a failure |
| Result | the last `text` event, parsed as the Kimi driver does (`extractJsonResult`) |
| Snapshot | `.local/share/opencode/opencode.db` and `opencode.db-wal` (as the P1 code lists), CLI stopped; or checkpoint first with `opencode db "pragma wal_checkpoint(TRUNCATE)"` and take the one file |
| Image | `ripgrep`, `git`, bash on PATH; the binary from the lock file |

### What a zai backend must do

| Duty | Why |
| --- | --- |
| Accept `POST …/chat/completions` only, bearer = the turn key; replace it by the plan key; forward to `https://api.z.ai/api/coding/paas/v4/chat/completions` | the only request the CLI makes |
| Allow a fixed set of body fields: `model`, `messages`, `tools`, `tool_choice` (`auto`, and `required` if the server path is used), `stream`, `stream_options`, `max_tokens`, `thinking`, `reasoning_effort` | everything the CLI sent; anything else is not from the CLI |
| Pin `model` to the turn's model and bound `max_tokens` (the CLI sends 32 000) | the key in the sandbox is reachable by the agent's shell if it is in the environment |
| Require `stream: true` and `stream_options.include_usage`, read `usage` from the chunk that carries `finish_reason`, treat a stream without it or without `[DONE]` as unmetered | usage is only there |
| Meter: `prompt_tokens`, `cached_tokens`, `completion_tokens` (reasoning included), `reasoning_tokens` | same fields on every answer |
| Never return HTTP 200 with a non-stream body to a streaming request: turn `{code,msg,success:false}` objects and any non-SSE 200 into a 4xx/5xx | the CLI resends without pause |
| Final refusals (budget, revoked key, quota, policy): a 4xx that is not 408/409/429, **no `retry-after`**, body `{"error":{"message":…}}` whose text has none of the retry words or the numbers 429/500/502/503/504/524 | otherwise the CLI retries 5 times, or sleeps as long as `retry-after` says |
| Still limit the request rate per turn key | a CLI defect or the model's shell can loop |
| Strip `set-cookie` (`acw_tc`) and Z.ai's ids from what the sandbox sees; drop or allow-list the CLI's `x-session-*`, `x-opencode-session-id`, `user-agent` towards Z.ai | the session id is the CLI's own; whether Z.ai uses `x-session-affinity` for its cache is unknown |
| Expect up to three kinds of requests per turn: the loop, the title request (no tools; absent with `--title`), a compaction request when the context fills | all go to the same path and model |
| Plan state: poll `GET /api/monitor/usage/quota/limit` with the plan key for the two windows and reset times; one key = one plan (`level`) | the model responses carry no quota information |

### What a fake Z.ai must replay

| Case | Shape |
| --- | --- |
| Normal text answer | SSE: reasoning chunks, content chunks, final chunk with `finish_reason:"stop"` + `usage`, `data: [DONE]` (sample 31/03) |
| Tool call | one chunk per call with `id`, `index`, `type`, `function{name, arguments}` complete; final chunk `finish_reason:"tool_calls"` + `usage` (sample 31/01); two calls in one answer |
| MCP tool call | same, name `raditi_<tool>` (sample 34/09) |
| Title request | no `tools`, three messages; answer is a short text (sample 31/02) |
| `tool_choice:"required"` + `StructuredOutput` | arguments = the result object (sample 49/08) |
| Usage variants | `cached_tokens` 0 and large; `reasoning_tokens` 0 and > 0 |
| Headers | `x-log-id`, `x-request-id`, `set-cookie: acw_tc=…` |
| Errors with status | 401 `{"error":{"code":"401","message":"token expired or incorrect"}}`, 401 code 1001, 400 code 1211, 400 code 1210, 429 code 1113 (samples 54, 21) |
| Hostile answers for the gateway's tests | HTTP 200 `application/json` `{"code":401,"msg":…,"success":false}`; HTTP 200 `{"code":500,"msg":"404 NOT_FOUND"}`; a stream cut before the usage chunk; a stream with no `[DONE]`; a `retry-after` header |
| Quota endpoint | the JSON of section 10 with two windows and `level` |

## 13. Risks and unknowns

1. **gVisor**: every run here was under `runc` on Docker Desktop. A Bun executable under `runsc` was not
   tried.
2. **x64**: only the arm64 binary was run.
3. **Quota exhaustion answer** and its headers are unknown; so is the credit formula, the number of
   parallel requests the plan allows, and whether Z.ai keys its prompt cache on `x-session-affinity`.
4. **Result reliability**: three turns. Nothing here says how often GLM drops the JSON on long turns; the
   product's "one attempt to fix it" stays necessary. `change_type` semantics need wording.
5. **The turn key is within the agent's reach** unless it comes through `{file:}`; even then it lives in
   the CLI's memory, and whether a same-uid process can read that under gVisor was not examined.
6. **`notifications/cancelled` after every completed MCP call**: the MCP role must treat a cancel for a
   finished request as nothing.
7. **Auto-compaction and the `task` tool** make extra model requests and child sessions; neither was
   triggered. `max_tokens` 32 000 and the 300 s header/chunk timeouts are the CLI's defaults.
8. **Which of two flags** keeps the repository's `AGENTS.md`/`CLAUDE.md` out of the prompt
   (`OPENCODE_DISABLE_PROJECT_CONFIG` or `OPENCODE_DISABLE_CLAUDE_CODE`) was not separated; both were set.
9. **Attachments (`-f`)**, images, `opencode acp`, session move to a repository with another root commit,
   a `deny` rule without `continue_loop_on_deny` — not run.
10. **The npm lookup has no flag**; the read-only config directory is a side effect of the code, not a
    documented switch. Both it and the binary path are tied to version 1.18.34.
11. The catalogue snapshot inside the binary fixes `glm-5.3` limits at build time; a custom provider entry
    states them explicitly instead.

## 14. Requests, leftovers

- To `api.z.ai`: 30 model requests through the recording proxy (`opencode-cli/upstream-count.txt`), 8
  quota/usage reads, 5 direct error probes (3 of them without the real key). All prompts synthetic.
- The key was only ever in the environment of the host proxy and of three short host scripts, each
  started through `with-zai-key.sh` (which takes the single `ZAI_API_KEY` line of the repository `.env`).
  Containers had dummy tokens. `leak-check.mjs`: no part of the key in `samples/`, `opencode-cli/`,
  `progress/`, `oc-proxy.log`.
- Removed: containers `raditi-glm-*`, network `raditi-glm-net`, volumes `raditi-glm-home*`,
  `raditi-glm-work*`, image `raditi-glm-opencode:1.18.34`, the proxy process.
- Left: files under `scratchpad/glm/` (`opencode-cli/`, `samples/3x–5x`, `oc-proxy.mjs`, `oc-proxy.log`,
  `oc-proxy.port`, `probe-quota*.mjs`, `probe-coding-errors.mjs`, `leak-check.mjs`); possibly BuildKit
  cache layers of the removed image (not pruned: the builder is shared with other sessions). The 2 320
  identical samples of the request storm were cut to three (`39-err-json200-short`); `39-err-json200`
  keeps only its MCP records and the heads of stdout/stderr.
- One planned step was not done: a helper command that would have removed a file inside the test
  container was stopped by the safety check, so the global `AGENTS.md` marker stayed in the home volume
  for runs 35–36 (it only adds one line to the system prompt).
