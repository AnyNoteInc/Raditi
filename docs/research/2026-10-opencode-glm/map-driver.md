# Map: what an OpenCode driver needs from the sandbox and the supervisor

Reader's notes for the OpenCode + GLM pivot. Nothing in the repository was changed.

- Repository state read: committed tree `HEAD` = `c9be168` on `codex/p3-llm-gateway` (`git show HEAD:<path>`). The driver-related paths (`packages/agent-drivers`, `infra/sandbox`, `apps/orchestrator/src/{turns,sessions,drivers,runner}`, `apps/orchestrator/scripts`, `infra/dev/llm-verify`, `packages/sandbox-providers`) have no uncommitted changes.
- Evidence labels used below:
  - **[repo]** committed code, cited as `file:line`.
  - **[probe]** live observations of the real `opencode` 1.18.34 binary by the parallel `probe-opencode` agent (`glm/opencode-cli/…`, `glm/progress/probe-opencode.md`). The probe was still running when this was written: its final word is `opencode-protocol.md`.
  - **[src-1.18.32]** upstream source at commit `545f51d26cc39a907d2867492d498d9607ea5fa4` (the commit `packages/agent-drivers/src/fixtures/README.md:14` pins), read through WebFetch summaries. One patch version older than the pinned CLI and summarised by a small model: leads, not proof.
  - **[inference]** my reasoning, not checked anywhere.

## 0. Short answer

1. The port and the supervisor need no change for OpenCode: `'opencode'` is already a member of `agentDriverIds` [repo `packages/domain/src/ports/agent-driver.ts:15`], the event parser, the result extraction and a session allowlist exist since P1, and nothing in `turns/`, `sessions/` or `runner/` branches on a CLI name (section 9).
2. Missing in the driver: `prepare` and `command` (both throw `NOT_IMPLEMENTED`, `packages/agent-drivers/src/opencode.ts:31-36`). Everything CLI-specific that Codex and Kimi do there has to be designed for OpenCode: config, key delivery, wrapper, prompt through stdin, instructions, result contract, protection from the site repository's own OpenCode files.
3. The committed P1 parser and result extraction read the real 1.18.34 output correctly. I ran `parseOpencodeEvent` and `extractJsonResult` from the committed files, read-only, over the probe's captured stdout:
   - `runs/31-run-a-default`: `started`, `tool_call` ×2, `command` (exit 0), `usage`, `started`, `message`, `usage`, `completed`;
   - `runs/34-run-c-mcp`: `tool_call` for `raditi_site_info` and `raditi_wp_rest`;
   - `runs/35-run-d1-result`, `36-run-d2-result`, `36-run-d3-result` (real `glm-5.3`, result contract in the agent prompt): a `TurnResult` with all seven keys is extracted in 3 of 3, one of them with `needs_approval: true`.
4. Three findings decide the design and are not solved by copying Codex or Kimi:
   - **Keys.** With the keys in the CLI's environment (`{env:…}` in the config) every tool command inherits them and can also read `/proc/<pid>/environ` of the CLI [probe run A: `own env names: … RADITI_LLM_KEY RADITI_MCP_TOKEN`]. Codex filters the child environment, Kimi keeps the keys out of the environment entirely; the stands assert both. OpenCode needs another channel (section 5.3).
   - **Untrusted repository.** Without `OPENCODE_DISABLE_PROJECT_CONFIG=1` a plugin file in the site repository (`.opencode/plugin/*.js`) is executed inside the CLI process, and the project's `opencode.json`, agents, skills and MCP servers are merged [probe run 32-plant: `plugin ran: yes`; with the flag: `plugin ran: no`, no planted agent, skill or config].
   - **Session file.** After a normal exit the session lives mostly in the SQLite WAL: `opencode.db` 249 856 bytes, `opencode.db-wal` 1 165 992 bytes [probe run A `files.txt`]. The snapshot must carry both files (the P1 allowlist already names both) and resume in a new container from exactly these two files is still unproven.
5. Unproven and blocking: the Bun-compiled binary under gVisor (`runsc`); resume from the two snapshot files alone (resume with the whole home kept works, probe run B); what OpenCode retries; a key channel that tool commands cannot read.

## 1. The AgentDriver contract, point by point

Port: `packages/domain/src/ports/agent-driver.ts:316-332`.

| # | Contract point [repo] | Codex | Kimi | OpenCode today (P1) |
| --- | --- | --- | --- | --- |
| 1 | `id: AgentDriverId` (`agent-driver.ts:15-16,317`). Checked against the key policy (`turn-supervisor.ts:76`), stored in the plan (`turn-executor.ts:331`), picks the parser on the executor (`local-turn-executor.ts:80`, `runner.module.ts:99`), written to the snapshot manifest (`snapshot-manifest.ts:32`), must equal the previous snapshot's (`turn-supervisor.ts:324`) | `'codex'` `codex.ts:77` | `'kimi'` `kimi.ts:73` | `'opencode'` `opencode.ts:28` — present |
| 2 | `image` pinned by digest (`agent-driver.ts:318-319`). One stack image for every driver from `SANDBOX_IMAGE` (`agent-drivers/src/config.ts:11-37`); production refuses the all-zero placeholder (`config.ts:29-33`) | `codex.ts:75,78` | `kimi.ts:71,74` | `opencode.ts:26,29` — present |
| 3 | `capabilities` (`agent-driver.ts:18-28`). Not read by the supervisor; mirrored in the seed (`packages/db/prisma/seed/data.ts:144-178`) | all true (`codex.ts:79`) | `outputSchema:false, images:false` (`kimi.ts:75`) | same as Kimi (`opencode.ts:30`) |
| 4 | `prepare(context): PreparedRun` (`agent-driver.ts:63-79,321`) — files only under `/agent-home`, non-secret env, secrets only under `/run/raditi/secrets` | `codex.ts:80-125` | `kimi.ts:76-164` | throws `NOT_IMPLEMENTED` (`opencode.ts:31-33`) |
| 5 | `command(run, turn): string[]` (`agent-driver.ts:322-326`) — argv of a fresh run or a resume of `context.nativeSessionId`; may stage input files into `run.files` | `codex.ts:126-165` | `kimi.ts:165-208` | throws (`opencode.ts:34-36`) |
| 6 | `parseEvent(line): AgentEvent[]`, stateless, unknown lines give `[]` (`agent-driver.ts:327-328`) | `codex-events.ts:16-95` | `kimi-events.ts:6-44` | `opencode-events.ts:15-66` — present |
| 7 | `sessionState(run): SessionState` (`agent-driver.ts:211-220,329`) — allowlist of session files under a root in `/agent-home` | `{root:/agent-home/codex, include:['sessions']}` `codex.ts:167-170` | index + `state.json` + `agents` of the one session; needs `nativeSessionId` (`kimi.ts:210-219`, `session-paths.ts:8-15`) | `{root:/agent-home/opencode, include:['.local/share/opencode/opencode.db','…/opencode.db-wal']}` `opencode.ts:15-22,38-42` — present |
| 8 | `extractResult(events, lastMessage)` (`agent-driver.ts:330-331`) | `extractJsonResult` (`jsonl.ts:99-112`) | same | same (`opencode.ts:43`) — present |

### 1.1 `prepare` in detail

What every driver must satisfy [repo]:

- **Purity.** `prepare` is called three ways: a dry run before the lease with stand-in keys (`turn-supervisor.ts:262-266`, `newTurnKeys()`), the real run (`turn-supervisor.ts:196`), and recovery of a running turn from the stored plan (`turn-exec-recovery.ts:855-867`). No I/O, same output for the same context.
- **Context validation.** `runContextSchema(effort)` (`cli-run.ts:35-46`): URLs are `http(s)` without credentials, query or fragment; each credential is 1–8192 printable ASCII characters; model 1–200 characters; instructions up to 256 KiB; `nativeSessionId` by `nativeSessionIdSchema` (`agent-driver.ts:263`). Codex: `codex.ts:22-28` (efforts `none…ultra`); Kimi: `kimi.ts:29-30,45-47` (efforts `low|high|max`).
- **A missing reasoning effort is accepted in `prepare`** (the schema is `effort.nullable().optional()`): recovery prepares a historical plan only to learn `sessionState`. `command` is the one that refuses to launch without a profile (`codex.ts:129-130`, `kimi.ts:167-168`).
- **Files**: normalized paths strictly under `/agent-home`, no `.git` segment, never the working copy (`agent-driver.ts:98-135`); at most 256 files and 4 MiB together with the secrets (`agent-driver.ts:84-96,137-153`). Default mode on write is 0600 (`local-turn-executor.ts:121`).
- **Env** (`PreparedRun.env`): never a credential (`agent-driver.ts:71-76`). At exec it must also pass `sandboxEnvSchema` (`sandbox-provider.ts:261-282`, enforced by `assertExecSpec` in `docker-sandbox.ts:215`): at most 64 variables, each value at most 4096 characters, no name matching `KEY|TOKEN|SECRET|PASS|CREDENTIAL`, no value that looks like a key (`sk-…` included).
- **Secrets**: `turnSecrets(context)` — exactly two files, `/run/raditi/secrets/llm` and `/run/raditi/secrets/mcp`, mode 0400 (`cli-run.ts:15-16,48-51`). The tmpfs is 2 MiB, `noexec` (`packages/sandbox-providers/src/docker.ts:53`).
- **No credential anywhere else**: `checkPreparedRun` refuses a run whose file contents, env values or argv contain a turn credential verbatim (`turn-supervisor.ts:338-357`, `agent-driver.ts:194-203`); the executor repeats the check (`local-turn-executor.ts:73-76`).

What Codex writes (`codex.ts:84-121`): `config.toml`, `AGENTS.md`, `output-schema.json`, `run.mjs`; env `CODEX_HOME`, `NO_COLOR` (`codex.ts:122`).
What Kimi writes (`kimi.ts:80-160`): `AGENTS.md`, `raditi-agent.md`, `config.toml`, `mcp.json`, `cli-env.json`, `run.mjs`; env `HOME`, `KIMI_CODE_HOME`, `NO_COLOR` (`kimi.ts:161`).

### 1.2 `command` in detail

- Both drivers return the fixed argv `['node', <wrapper>]` (`codex.ts:164`, `kimi.ts:207`) and stage the real CLI arguments and the prompt as files with `stageFiles` (`cli-run.ts:67-73`). Reasons [repo]: the exec header (argv + cwd + env as JSON) is limited to 64 KiB in the sandbox runtime (`packages/sandbox-providers/runtime/runtime.mjs:236`), one argv item to 128 KiB and all of them to 256 KiB (`sandbox-provider.ts:293-305`), and Linux refuses a single argument above 128 KiB (`E2BIG`, measured for Kimi with 100 000 Cyrillic characters, `docs/plan/23-p5-kimi-driver.md`). The turn plan allows a 100 000-character prompt (`turn-executor.ts:265-270,297`).
- The core calls `command` before it validates and writes `PreparedRun.files` (`turn-supervisor.ts:196-198`), so staging there is allowed by the port comment (`agent-driver.ts:322-326`).
- Attachments are checked with the plan's own rule, `assertAttachments` (`cli-run.ts:57-60`): at most 100 paths under `/workspace/inbox`.
- Resume: Codex adds `resume` and the id (`codex.ts:146,155`); Kimi swaps `--agent-file` for `--session <id>` and stages `resume-instructions.json` (`kimi.ts:179-200`).
- Prompt framing: Codex appends the attachment list (`codex.ts:138-140`); Kimi prefixes `Client request:\n` so that `-` and `/goal …` stay text (`kimi.ts:171-175`).
- Images: Codex passes `--image` for picture files without a comma in the name (`codex.ts:68,135-137,153`); Kimi only lists paths.

### 1.3 The launch wrapper (`run.mjs`) — where the two keys go today

| | Codex [repo `codex.ts:89-119`] | Kimi [repo `kimi.ts:108-158`] |
| --- | --- | --- |
| Secret files | read once, `unlinkSync` before the CLI starts | same |
| Key in the CLI | environment of the CLI process: `RADITI_LLM_TOKEN` (provider `env_key`), `RADITI_MCP_TOKEN` (`bearer_token_env_var`) — `codex.ts:54,58,105-108` | non-enumerable properties of a replaced `process.env` object inside the same Node process (`kimi.ts:127-131,151`); the CLI entry point is imported, not spawned (`kimi.ts:152-153`) |
| Tool commands see the key | not in their environment (`shell_environment_policy`, `codex.ts:49-50`); **can** read `/proc/<pid>/environ` of the CLI — accepted and documented (`codex.ts:90-99`) | no: not in any `/proc/*/environ`; the fixture asserts it (`apps/orchestrator/scripts/kimi-runner-fixture.mjs:70-73`) |
| Prompt | `prompt.txt` opened as stdin of the CLI (`codex.ts:109-112`) | `prompt.txt` read into `process.argv` in memory (`kimi.ts:132,152`) |
| Process group | child spawned without `detached`: stays in the runtime's group so timeout and cancel kill both (`codex.ts:110-111`; runtime kills the group, `runtime.mjs:281-295,335-340`) | same process |

### 1.4 Common events: who emits what

Schema: `agent-driver.ts:266-296`; limits `agent-driver.ts:242-259`.

| Event | Codex (`codex-events.ts`) | Kimi (`kimi-events.ts`) | OpenCode P1 (`opencode-events.ts`) |
| --- | --- | --- | --- |
| `started` + `nativeSessionId` | `thread.started` `:19-22` | `session.resume_hint`, printed after the answer `:9-12` | every `step_start`, from `row.sessionID` `:21-24` (several per turn) |
| `message` | `item.completed`/`agent_message` `:57` | assistant `content` `:14` | `text` part `:25` |
| `command` | `command_execution` with exit code `:58-66` | `Bash` tool call, `exitCode: null` `:21-25` | `tool_use` of tool `bash`, exit from `state.metadata.exit` `:32-37` |
| `file_change` | `file_change` item `:72-92` | — | — |
| `tool_call` | `mcp_tool_call`, `collab_tool_call` `:67-71` | — (no tool name on the result line `:41-42`) | every finished tool part, `ok` = `completed` `:26-31` |
| `question` | — | `AskUserQuestion` `:26-39` | — |
| `usage` | once, on `turn.completed` `:27-53` | — | per step, on `step_finish`; `output` gets reasoning added once `:40-60` |
| `completed` | `turn.completed` `:52` | — | `step_finish` with `reason: 'stop'` `:61` |
| `failed` | only `turn.failed` `:23-26` | — | `error` row `:19-20`; `step_finish` with reason `error`, `length`, `content-filter` `:62-64` |

What the product code reads from these today [repo]: `failed` ends the turn (`turn-attempt.ts:300-309`), the last `started.nativeSessionId` names the session (`turn-attempt.ts:335-338`, `turn-journal.ts:56,203`), the last `message` carries the result (`turn-result.ts:46`). Everything else is journaled for the chat (P12).

## 2. What the supervisor, the executor and the runtime do around the driver

Order of one turn [repo]:

1. `validate` (`turn-supervisor.ts:269-330`): sandbox policy, turn limit above the 3-minute reserve, snapshot plan with `driver: {id, version}`; a previous snapshot must have the same image, driver id and driver version (`:315-327`).
2. Policy: `policy.driverId === driver.id`, the plan's reasoning effort equals the policy's (`turn-supervisor.ts:75-85`).
3. Dry run of `prepare` + `command` (`:262-266`).
4. Lease, assignment, key issue (`:89-155`). `issue` requires the driver's row in `agent_drivers` to be enabled and an account of that driver (`apps/orchestrator/src/llm/turn-credentials.ts:394,451`).
5. Base bundle with the full ancestry of the base commit, cloned into `/workspace/repo` without origin, hooks or submodules (`git-workspace.service.ts:211-240`, `base-bundle.ts:30-77`).
6. Real `prepare`, `command`, `checkPreparedRun` (`:196-199`).
7. Executor (`local-turn-executor.ts:71-128`): create the container, import the bundle, restore the previous home (`tar --extract … --keep-old-files`, `sandbox-snapshot.ts:143-171`), **then** write the driver files and after them the secrets (`:116-126`).
8. Launch (`local-turn-executor.ts:256-270`): `exec({argv, cwd: '/workspace/repo', env: prepared.env, timeoutMs})`. The runtime spawns it detached in its own process group with **stdin = an empty regular file**, stdout and stderr as pipes, no TTY (`runtime.mjs:325-330`, `docker-sandbox.ts:243`); environment is the container's (`LANG`, `HOME=/agent-home`, `docker.ts:370`) plus the driver's env.
9. Time: turn at most 20 minutes (`sandbox-provider.ts:196`); the agent's exec ends 3 minutes earlier (`turn-supervisor.ts:237`, `TURN_FINALIZE_RESERVE_MS`, `turn-runner.ts:27`). On timeout the runtime sends SIGTERM to the group and SIGKILL 300 ms later (`runtime.mjs:335-346`).
10. Output (`turn-output.ts`): stdout only is parsed; strict UTF-8; a line above 256 KiB is skipped and replaced by a fixed message (`:16,105-110`); 32 MiB for the whole turn (`:14`); 10 000 events (`agent-driver.ts:258`); a line or a parsed event that contains a turn credential rejects the turn (`:66-80`).
11. Success = exit reason `exited`, code 0, no `failed` event (`turn-attempt.ts:300-309`).
12. `quiesce` — every process except the keepalive gets SIGTERM, then SIGKILL (`runtime.mjs:440-483`) — then `readTurnResult` (`turn-result.ts:40-54`), `sessionState`, capture (`turn-attempt.ts:331-342`).
13. Capture (`sandbox-snapshot.ts:62-141`): `tar --create --zstd --format=ustar` of the allowlist; refused when a symlink is on the path, when an archive or the patch contains a turn credential, or above the limits: archive 16 MiB, one file 32 MiB, expanded 128 MiB, 10 000 entries (`packages/domain/src/sessions/session-state.ts:6-15`); only plain files and directories, modes up to 0777 (`archive-validation.ts:157-173`). The allowlist itself: at most 32 include paths, no wildcard characters, no `.git` segment (`session-state.ts:18-46`).
14. Snapshot saved with `driver: {id, version, nativeSessionId}` and `home` (`turn-attempt.ts:362-381`); the next turn takes `nativeSessionId` from the manifest (`turn-supervisor.ts:190-195`).
15. An invalid result ends the turn as `TURN_OUTPUT_REJECTED`; the «one attempt to fix» of spec §8 is not implemented (`turn-result.ts:34-38`).

Container facts the CLI lives with [repo `packages/sandbox-providers/src/docker.ts:49-55,379-391`]: read-only rootfs; tmpfs `/workspace` 512 MB, `/agent-home` 256 MB, `/tmp` 64 MB (both executable), `/run/raditi/secrets` 2 MB noexec; uid 10001; no capabilities; at most 2 vCPU, 4096 MiB, 512 processes; network only to `sandbox-gw` (name added through `ExtraHosts`, `gateway/manager.ts:330`), no DNS.

## 3. Shared between drivers, and per CLI

Shared [repo `packages/agent-drivers/src`]:

| File | What |
| --- | --- |
| `cli-run.ts` | `llmKey`, `mcpKey`, `turnSecrets`, `runContextSchema(effort)`, `assertAttachments`, `stageFiles` |
| `jsonl.ts` | bounded JSON line parsing (256 KiB, depth 32, 10 000 nodes), `events()` through `agentEventSchema`, `message()` with the truncation marker, `failed()`, `nativeSessionId()`, `extractJsonResult()` |
| `output-schema.ts` | `RESULT_SIZE_NOTE`, `strictOutputSchema()` (only Codex uses the strict form) |
| `config.ts` | one image for all drivers, `agentDriverConfigFromEnv` |
| `registry.ts` | `createAgentDrivers`, `agentEventParser`, `createAgentDriverRegistry` |
| `session-paths.ts` | `requireNativeSessionId` (shared); `KIMI_WORKDIR_KEY`, `QWEN_PROJECT_KEY` (per CLI) |

Per CLI: `codex.ts`, `codex-events.ts`, `kimi.ts`, `kimi-events.ts`, `qwen*.ts`, `opencode*.ts`, the JSONL fixtures, and the CLI packages in `cli/package.json`.

Sits in a per-CLI file but an OpenCode driver needs it too [repo]: the result contract text `resultInstructions` — «End the turn with one JSON object … matching this JSON Schema» plus the draft-7 schema of `turnResultSchema` (`kimi.ts:31-35`). Any CLI without an output-schema flag needs it; it should move next to `RESULT_SIZE_NOTE`.

## 4. What the P1 OpenCode code covers, and what is missing

Covered [repo]:

- `id`, `image`, `capabilities` (`opencode.ts:25-30`); registered in `createAgentDrivers` and in the parser map (`registry.ts:27,35`); seeded as a disabled driver (`seed/data.ts:173-178`).
- `parseOpencodeEvent` (`opencode-events.ts`), with fixture `fixtures/opencode.jsonl` and tests (`events.test.ts:91`, plus the shared boundary tests). Checked here against real 1.18.34 output (section 0, point 3).
- `sessionState` allowlist `opencode.db` + `opencode.db-wal` under `HOME=/agent-home/opencode` (`opencode.ts:15-22`), tests `session-paths.test.ts:98-113`, `drivers.test.ts:40-52`.
- `extractResult` = `extractJsonResult`.
- Paths: the P1 comment (`opencode.ts:7-13`) matches `opencode debug paths` of 1.18.34 [probe `help/02-offline-debug.txt`]: data `/agent-home/opencode/.local/share/opencode`, config `…/.config/opencode`, cache `…/.cache/opencode`, state `…/.local/state/opencode`, tmp `/tmp/opencode`.

Missing:

1. `prepare` and `command` (`opencode.ts:31-36`); the test that pins them as not implemented (`drivers.test.ts:104-115`) has to be replaced by real tests of the kind `codex.test.ts` and `kimi.test.ts` hold (credentials only in tmpfs files, platform settings above project config, prompt staging, attachment rules, effort profiles, resume).
2. The launch wrapper and the choice of where the two keys live (section 5.3).
3. The reasoning profile enum for `runContextSchema`. For `glm-5.3` the binary's own catalogue names efforts `low`, `high`, `max` [probe `strings/builtin-zai-providers.json`].
4. Platform instructions and the result contract in a place the site repository cannot override.
5. Enabling: `ENABLED_AGENT_DRIVERS` is `['codex','kimi']` (`apps/orchestrator/src/drivers/drivers.module.ts:9`); the seed sets `enabled` on create only (`seed/data.ts:139`), so an existing database keeps `opencode` disabled and `issue` refuses it (`turn-credentials.ts:394`).
6. Parser gaps, none blocking:
   - no `file_change` events (tool parts `write`/`edit` carry `state.input.filePath`; run A shows `"tool":"write"` with `filePath`);
   - `started` repeats on every step; harmless, the last one wins;
   - `usage` is per step, Codex's is per turn — a consumer that sums must know (nobody reads it yet);
   - events of child sessions (subagents) would be printed under the parent's `sessionID` [src-1.18.32 `run.ts` loop]; with subagents denied this does not arise;
   - `reasoning` rows appear only with `--thinking` [src-1.18.32]; the parser ignores them anyway.
7. The comment «verified in P5» and «P5 can use export/import instead» (`opencode.ts:7,39`) is stale: P5 became the Kimi driver.

## 5. What an OpenCode driver must provide

### 5.1 The CLI surface that is confirmed

`opencode run [message..]` in 1.18.34 [probe `help/01-commands-help.txt`]: `--format json`, `-s/--session <id>`, `-c/--continue`, `--fork`, `-m/--model provider/model`, `--agent`, `--variant` («provider-specific reasoning effort, e.g., high, max, minimal»), `-f/--file`, `--title`, `--thinking`, `--auto` («auto-approve permissions that are not explicitly denied»), `--dir`, `--pure`, `--print-logs`, `--log-level`. There is no output-schema flag.

Behaviour [src-1.18.32 `packages/opencode/src/cli/cmd/run.ts`]:

- stdin is read whenever it is not a TTY (`Bun.stdin.text()`) and appended to the positional message; with no positional message the prompt is stdin alone; an empty prompt exits 1 («You must provide a message or a command»);
- each JSON line is `{type, timestamp, sessionID, ...data}` with types `tool_use` (tool part `completed` or `error`), `step_start`, `step_finish`, `text` (finished text part), `reasoning` (only with `--thinking`), `error` (on `session.error`); the loop ends on session status `idle`; a session error sets exit code 1;
- a non-interactive session is created with `question`, `plan_enter`, `plan_exit` denied; a permission request is rejected unless `--auto`;
- `--session <id>` loads that session; an unknown id is an error.

Confirmed live [probe]:

- run A: exit 0 in 7 s, session id `ses_00000000000000000000000001` (fits `nativeSessionIdSchema`), default agent `build`, `edit` and `bash` evaluated as `allow` by default, **three provider requests for a two-step turn** — the extra one is the title agent on the same model (`stream … small=true agent=title`, `runs/31-run-a-default/stderr.txt`);
- run B: the prompt given only through stdin is accepted (`scripts/run-turn.sh`: `opencode run --format json "$@" < prompt`), and the session of run A continues in a new container that keeps the whole home volume (same `sessionID` in `runs/33-run-b-continue/stdout.txt`);
- an `edit` tool line carries the whole patch twice (`metadata.diff`, `metadata.filediff`): for a large file such a line can pass 256 KiB and is then replaced by the supervisor's fixed message (`turn-output.ts:16-22`), which costs only that `tool_call` event.

### 5.2 Files and environment

Everything under `/agent-home/opencode` (the root the tests require, `drivers.test.ts:87`), mode 0600:

| File | Content | Note |
| --- | --- | --- |
| `run.mjs` | Node wrapper: reads and unlinks the two secret files, builds the CLI environment, opens `prompt.txt` as stdin, spawns the pinned binary in the same process group, passes its exit code on | Node is in the image; same pattern as `codex.ts:100-118` |
| `cli-args.json`, `prompt.txt` | staged by `command()` | keeps argv at two fixed items |
| config JSON | provider, model, MCP server, permissions, switched-off features | handed over as `OPENCODE_CONFIG_CONTENT` by the wrapper: values in the exec env are capped at 4096 characters (`sandbox-provider.ts:261`), and inline content is merged after project config [src-1.18.32 `config.ts`: well-known → global → `OPENCODE_CONFIG` → project → `.opencode` dirs → `OPENCODE_CONFIG_CONTENT` → account → managed] |
| instructions file | `context.instructions` + the result contract | referenced by absolute path from `instructions` or the global `~/.config/opencode/AGENTS.md`; never pasted into the config JSON (see the caution below) |

Config keys that exist in 1.18.34 [probe `strings/ctx-config-schema.txt`, `ctx-provider-config.txt`, `ctx-mcp-config.txt`, `ctx-permission-config.txt`]:

- top level: `model`, `small_model`, `provider`, `enabled_providers`, `disabled_providers`, `mcp`, `agent`, `default_agent`, `permission`, `tools`, `instructions`, `plugin`, `share` (`manual|auto|disabled`), `autoupdate`, `snapshot` (boolean), `lsp`, `formatter`, `compaction`, `skills`, `watcher`, `shell`, `experimental`;
- `provider.<id>`: `npm`, `name`, `env[]`, `options {apiKey, baseURL, timeout, headerTimeout (default 300 000 ms), chunkTimeout (default 300 000 ms), setCacheKey}`, `models.<id> {name, reasoning, tool_call, temperature, attachment, interleaved, limit {context, output}, modalities, options, headers, variants}`;
- `mcp.<name>` remote: `{type:'remote', url, headers, oauth: false | {...}, enabled, timeout}` — «Timeout in ms for MCP server requests. Defaults to 5000»;
- `permission`: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `question`, `webfetch`, `websearch`, `lsp`, `doom_loop`, `skill`, plus any tool name; values `ask|allow|deny` or a pattern map.

The provider used by the probe, as a starting shape (`glm/opencode-cli/configs/a-default.json`): a custom provider with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, `options.apiKey`, one model with `reasoning`, `tool_call`, `interleaved.field = "reasoning_content"`, `limit {context: 1000000, output: 131072}`. `@ai-sdk/openai-compatible` is bundled in the binary; a package that is not bundled would be installed from npm at run time [src-1.18.32 `provider.ts`] — impossible in the sandbox, so only a bundled package can be named.

Environment of the CLI (names pass the sandbox rule; none looks like a credential). Present in the 1.18.34 binary [probe `strings/env-names.txt`]:

| Variable | Why |
| --- | --- |
| `HOME=/agent-home/opencode` | all XDG paths follow it |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | the site repository's `opencode.json`, `.opencode/` agents, plugins, skills are ignored [probe 32-plant] |
| `OPENCODE_CONFIG_CONTENT` | platform config above everything a repository could add |
| `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1` | no network: at start the CLI resolves and connects to `models.opencode.ai` [probe `runs/30-pre-config/sink.jsonl`] |
| `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE` | candidates; the effect of each is for the probe to show |
| `OPENCODE_DB` | optional: an absolute path moves the SQLite file [src-1.18.32 `database.ts`], e.g. into a directory of its own |
| `NO_COLOR=1` | as the other drivers |

Cautions:

- `{env:VAR}` and `{file:path}` are substituted in the raw config text before JSON parsing; `{env:}` inserts the value unescaped, `{file:}` trims and JSON-escapes it, a missing file is an error [src-1.18.32 `config/variable.ts`]. Untrusted text (the site's part of `context.instructions`, a model name) inside the config text could therefore pull an environment variable or a file into the config. Build the config with `JSON.stringify` from fixed keys and keep instructions in their own file.
- OpenCode writes a `.gitignore` into every config directory and starts a background `npm install @opencode-ai/plugin` there [src-1.18.32 `config.ts`; probe: `/agent-home/opencode/.config/opencode/.gitignore`, four `/agent-home/.npm/_logs/*` files]. With project config enabled the same happens in the repository's `.opencode/`: after the project-config test the working copy holds `repo/.opencode/.gitignore` [probe `runs/33-run-b-continue/files.txt`]. Capture takes untracked files of the working copy for publication (`sandbox-snapshot.ts:91-111`), so the stand has to assert the published tree, as `verify-runner.mjs:875-890` does. Another reason for `OPENCODE_DISABLE_PROJECT_CONFIG`.
- The probe's hardened config (`configs/b-hardened.json`: `small_model`, `autoupdate: false`, `share: "disabled"`, `snapshot: false`, `lsp: false`, `formatter: false`, `plugin: []`, `enabled_providers`, denied `webfetch`, `websearch`, `task`, `skill`, `external_directory`, `doom_loop`, `question`) ran a turn with no outside DNS or TLS attempt (`runs/33-run-b-continue/sink.jsonl` is empty), where the default start had reached for `models.opencode.ai`.
- The snapshot feature is on by default and keeps a git directory under `…/opencode/snapshot/<project>/<hash>` (`tracking hash=…` in the run log; 21 files for a two-file repository). It lives on the 256 MB `/agent-home` tmpfs and duplicates what the platform already does: `snapshot: false`.
- Without `enabled_providers` the CLI also lists `opencode/*` models [probe `help/02-offline-debug.txt`]; restrict to the platform's provider and set `small_model` explicitly.

### 5.3 Where the turn key and the MCP token go

Fixed by the platform [repo]: both arrive only as the tmpfs files `/run/raditi/secrets/llm` and `/mcp` (`cli-run.ts:15-16`), never in a prepared file, env value or argv (`turn-supervisor.ts:353`); the home is snapshotted, so nothing under `/agent-home` may hold them; the output and the snapshot are scanned for them (`turn-output.ts:66-80`, `archive-validation.ts:233-244,322`).

OpenCode's ways to take a provider key [src-1.18.32 `provider.ts`]: provider env variable (config `provider.<id>.env`), the auth store (`auth.json`, also `OPENCODE_AUTH_CONTENT` in the binary's strings), config `options.apiKey`. The MCP token is a header in `mcp.<name>.headers` (`Authorization: Bearer …`).

| Option | Key visible to a tool command | State |
| --- | --- | --- |
| A. Wrapper puts both into the CLI's environment, config uses `{env:…}` | **yes**, twice: inherited environment and `/proc/<pid>/environ` | measured [probe run A `stdout.txt` line 3]. Worse than Codex (child env filtered) and Kimi (not in any environ) |
| B. Config uses `{file:/run/raditi/secrets/llm}` and the file stays | yes: same uid can read the file | no better |
| C. `{file:…}` of a one-shot source: the wrapper reads and unlinks the tmpfs files, then feeds each value through a pipe the config load consumes (an inherited descriptor, a FIFO) | no file, no environment; only CLI memory | **unverified**: how often 1.18.34 reads the config text, whether Bun reads such a path, gVisor, descriptor inheritance by tool commands |
| D. `auth.json` | yes: a file under `/agent-home` | rejected: also one step from the snapshot |
| E. A small forwarding process started by the wrapper on loopback inside the sandbox adds `Authorization` and forwards to `sandbox-gw`; the CLI gets a dummy key | the key is in no file and no environment of the CLI; a command can still spend the turn's budget through the forwarder, which it can equally do with a stolen key | **unverified**; more code shipped as a prepared file; independent of CLI internals |

What the stands assert today, as the bar to keep [repo]: for Kimi — no key in the command's environment, in any `/proc/*/environ`, and no secret file (`kimi-runner-fixture.mjs:70-73`); for Codex — no key in the command's environment and no secret file, with the CLI's own environ knowingly left out (`codex-runner-fixture.mjs:39-43`). Option A fails even the Codex bar. If only parity with Codex is reachable (key in the CLI's environ but not in children), the child environment still has to be cleaned, and nothing read so far gives OpenCode a setting for that.

### 5.4 Prompt, attachments, instructions

- Prompt: through stdin from `prompt.txt` (the runtime gives an empty stdin, so the wrapper must open the file itself). No positional message, so `-` and a leading `--…` stay text. Whether a leading `/` is read as a command in `run` mode is unverified; a label prefix as in `kimi.ts:173` removes the question and also guards the «empty message» exit for a whitespace-only prompt.
- Attachments: list the paths in the prompt, as Kimi does (`kimi.ts:174-175`). `glm-5.3` is text-only in the binary's catalogue (`modalities: ["text"]`; `glm-5.3-flash` lists image, video, pdf) [probe], so `images: false` stays. Reading `/workspace/inbox` is outside the project directory: `external_directory` has to allow it, otherwise the request is rejected in `run` mode.
- Instructions: OpenCode rebuilds the system prompt on every request from the agent prompt and the instruction files [src-1.18.32 `session/prompt.ts`, `session/instruction.ts`], so a resumed session gets the current platform instructions without Kimi's marker and preface logic (`kimi.ts:37-43,176-191`). To be proven by the same check `verify:codex` has («актуальные инструкции при resume», `docs/plan/22-p4-codex-driver.md`).
- Project instruction files (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) are looked up from the working directory unless `OPENCODE_DISABLE_PROJECT_CONFIG` is set; `~/.claude/CLAUDE.md` unless the Claude Code switch is off [src-1.18.32]. The platform already hands the driver platform + site instructions in `RunContext.instructions` (`agent-driver.ts:51`), so the CLI need not read the repository's files itself.

### 5.5 Protected settings

What Codex pins with `--config` overrides (`codex.ts:25-61,131-133`) and Kimi with its agent file and tool allowlist (`kimi.ts:28,83-93`), for OpenCode:

- model, provider address, MCP address, permissions — in the inline config, with project config disabled;
- tools: deny `task` (subagents `general`, `explore` exist by default [probe agent list]), `webfetch`, `websearch`, `question`, `skill`, `lsp`; allow `edit`, `bash`, `read` and the `raditi_*` MCP tools; `external_directory` only for `/workspace/inbox`;
- agent: a platform primary agent or the built-in `build`, named by `--agent`; `run` falls back to the default with a warning when the named agent is missing or a subagent [src-1.18.32] — the stand should assert the agent in the request;
- off: `share`, `autoupdate`, `snapshot`, `lsp`, `formatter`, plugins;
- `--title <fixed>`: a session created with a non-default title skips the title request [src-1.18.32 `prompt.ts`: skipped when the title is not the default, for child sessions and from the second user message on]. Otherwise every new session costs one more provider request with another system prompt, which the gateway's body policy and the stands' request counts must expect.

MCP [src-1.18.32 `mcp/index.ts`, probe schema and run C]:

- `type: 'remote'`, `url` = `context.mcp.url`, `headers.Authorization`, `oauth: false`, an explicit `timeout` (default 5 s is far below a WordPress write). This shape works live against a synthetic MCP server (`configs/c-mcp.json`, `runs/34-run-c-mcp`);
- tools reach the model as `<server>_<tool>`: `raditi_site_info`, `raditi_wp_rest` in the real output — the stands' pattern `/(^|[_.])site_info$/` matches (`verify-llm-gateway-drivers.mjs:253-257,314`);
- a platform agent set by `default_agent` with `agent.<name> {mode: 'primary', prompt, permission}` is used by `run` (same config);
- transport: Streamable HTTP first, SSE second; `sandbox-gw` lets `GET`, `POST`, `DELETE` on `/mcp` through with `authorization`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id` (`infra/sandbox/gateway.mjs:21-26,71-76`);
- **a server that fails to connect does not stop the run**: the turn goes on without the tools. Codex has `mcp_servers.raditi.required = true` (`codex.ts:59`). OpenCode has no such switch in what was read; the wrapper or the stand has to cover it.

### 5.6 The final result

No schema flag in `run`, so as with Kimi: the contract text and the JSON Schema go into the instructions; `extractJsonResult` takes the last message (`jsonl.ts:99-112`); the supervisor's second reading accepts one fenced block or the outermost braces (`turn-result.ts:18-25,44-50`). A final message above 20 000 characters is cut with a marker and no longer parses (`jsonl.ts:73-86`), hence `RESULT_SIZE_NOTE`.

The CLI has a structured-output mode in its session API (`format: json_schema` adds a `StructuredOutput` tool with `toolChoice: required`) [src-1.18.32 `prompt.ts`], but `opencode run` does not expose it. `capabilities.outputSchema` stays `false`.

First live sample [probe step 2d]: with the contract in the agent prompt, real `glm-5.3` ended three turns of three with a bare JSON object that passes `turnResultSchema` (Russian `client_message`, one turn with `needs_approval: true`). Three turns are a sample, not a rate; an invalid result still costs the whole turn (section 2, point 15).

### 5.7 Session files and resume

- Files [probe run A `files.txt`]: `opencode.db` 249 856, `opencode.db-shm` 32 768, `opencode.db-wal` 1 165 992 bytes after exit 0. The database is opened with `journal_mode = WAL`, `synchronous = NORMAL`, `cache_size = -64000`, a passive checkpoint at open, and migrations are applied at open [src-1.18.32 `core/src/database/database.ts`]. A database with its WAL exists even after `debug config` alone (267 832-byte WAL, run 30-pre-config).
- Allowlist: the two files P1 names. `-shm` is rebuilt by SQLite; whether 1.18.34 opens a restored `db` + `wal` pair cleanly is the first thing the resume check has to show.
- Never in the snapshot (already asserted by `session-paths.test.ts:104-112`): `auth.json`, `.config/opencode`, `log/`, `snapshot/`, `repos/`, `.cache`; also seen now: `.local/state/opencode/locks/`, `/agent-home/.npm`.
- Order on restore is safe: the archive is extracted first, the driver's files are written after it (`local-turn-executor.ts:111-126`).
- Size: the database holds every message and tool output of the task. The limits are 32 MiB per file and 16 MiB for the compressed archive; above them the turn ends with `snapshotTooLarge`. Worth one measurement on a long synthetic session.
- Resume: `--session <nativeSessionId>`; the same image and the same driver version are already enforced (`turn-supervisor.ts:323-325`), which also covers the schema migrations a new CLI version would apply. Shown so far: continuation in a new container with the whole home kept [probe run B]. Not shown: continuation from the two allowlisted files in an otherwise empty home, which is what a turn really gets.
- Project identity: the session row carries a `projectID` (`created id=… projectID=3811f8dc…` in the run log). The working copy is cloned anew each turn with the full ancestry (`git-workspace.service.ts:211-240`) at the same path `/workspace/repo`, so an id derived from the repository's history stays the same [inference]; to be confirmed by the resume in a second container.
- `opencode export` / `opencode import` exist in 1.18.34 [probe help] as the alternative P1 mentions (`opencode.ts:9`). It would need two more CLI runs inside the wrapper per turn; only worth it if the two-file restore fails.
- `sessionState` must work from `run.context` alone: recovery calls it with a run that has no files (`turn-exec-recovery.ts:636,864`). The P1 allowlist does not depend on the session id, so it does.

### 5.8 Failures and retries

- `error` rows become `failed` (`opencode-events.ts:19-20`), and the CLI exits 1 on a session error [src-1.18.32]; either alone fails the turn.
- A final `step_finish` whose reason is neither `stop` nor an error (an unknown finish reason from the provider) gives neither `completed` nor `failed`; the turn then depends on exit code and result alone, which the supervisor handles.
- What OpenCode retries by itself, how often and how long, was not read. The gateway stands require: a final refusal ends the turn after one provider request; a transient one is retried and the turn finishes (`verify-llm-gateway-stream.mjs:110,140,200,227`). For Kimi this needed a special answer shape because the CLI retries any in-stream error up to 10 times (`infra/dev/llm-verify/README.md`). The same study is needed for OpenCode, including `retry-after`, which `sandbox-gw` passes through (`gateway.mjs:27`).

## 6. The sandbox image and its lock

Today [repo]: `infra/sandbox/Dockerfile:8-36` — stage `runtime` copies `packages/agent-drivers/cli/{package.json,package-lock.json}`, runs `npm ci --ignore-scripts`, checks `npm ls @openai/codex@0.158.0` and `npm ls @moonshot-ai/kimi-code@2.1.1`, links `/usr/local/bin/codex` and `/usr/local/bin/kimi`. Tools present: git, zstd, curl, jq, ripgrep, fd, php-cli, composer. `cli-lock.test.ts` holds the rules: exact versions, exactly the two package names (`:27-37`), every lock entry with a registry tarball and sha512 (`:39-49`), the Dockerfile installs only from the lock and has one `npm ls <name>@<version>` per dependency (`:51-66`).

For OpenCode:

1. `cli/package.json`: `opencode-ai` at an exact version. The owner allowed 1.18.34; the P1 fixtures were written against 1.18.32 (`fixtures/README.md:14`).
2. Lock [probe `glm/opencode-cli/package-lock.json`]: `opencode-ai` (`hasInstallScript: true`, `bin: bin/opencode.exe`, 4 files, 7.9 KB) and twelve optional platform packages (`opencode-linux-arm64`, `-linux-arm64-musl`, `-linux-x64`, `-linux-x64-baseline`, `-linux-x64-musl`, `-linux-x64-baseline-musl`, three darwin, three windows), each with `resolved` and sha512 — compatible with the lock test's entry rule.
3. `npm ci --ignore-scripts` on arm64 installs two packages: the stub and `opencode-linux-arm64`, 185 MB unpacked [probe step 1a, registry metadata]. The postinstall does not run, and the probe starts the platform binary directly: `/usr/local/lib/raditi/…/node_modules/opencode-linux-arm64/bin/opencode` (`scripts/entry.sh`). The Dockerfile therefore needs an architecture-aware link to a fixed path such as `/usr/local/bin/opencode`; the driver runs in `core` and cannot know the VM's architecture.
4. On x64 both `opencode-linux-x64` and `opencode-linux-x64-baseline` match `os`/`cpu` and neither has a `libc` field [inference from the lock]: possibly two 185 MB binaries. To be checked on an x64 build (the CI runner is x64).
5. The binary is a glibc build; the base is Debian bookworm. `rg` is on PATH, so the CLI need not fetch its own into `~/.cache/opencode/bin`.
6. Tests and checks to adapt: the package-name list in `cli-lock.test.ts:27-31`, the `npm ls` lines in the Dockerfile and in `infra/dev/llm-verify/cli.Dockerfile:9-11`, `CLI_VERSIONS` in `infra/dev/llm-verify/cli.mjs:14`, the versions in the runner fixtures and `verify-runner.mjs:72`, `cli/README.md`. The version string is repeated in about ten places per CLI; the driver port has no version field and `driverVersion` comes from the caller (`turn-executor.ts:242`).
7. During «replacement first» the image carries three CLIs; the removal PR drops the Codex and Kimi lines, links and lock entries.
8. Not shown yet: the binary under `runsc`. Everything so far ran under Docker Desktop's runc on `Linux 6.12.76-linuxkit arm64` [probe `debug info`]. The supervisor stands create the sandbox with 1 vCPU and 1024 MiB (`verify-runner.mjs:580`); the CLI's SQLite page cache alone is set to 64 MB.

## 7. Routes the sandbox may call

[repo `infra/sandbox/gateway.mjs`]

- LLM: exactly `POST /codex/responses` and `POST /kimi/v1/chat/completions` (`:67-70`), matched on the whole `req.url`; anything else is `403 Request is not allowed` (`:79-93`).
- MCP: `/mcp` with `GET`, `POST`, `DELETE` (`:71-76`).
- `Host` must be `sandbox-gw` or `sandbox-gw:8080` (`:83`); at most 8 requests at once (`:86`).
- LLM request headers forwarded: `authorization`, `content-type`, `accept`, `user-agent`, `originator`, `session-id`, `thread-id`, `x-client-request-id`, three Codex headers, and `x-msh-*` (`:9-20,112-114`); other headers are dropped, a duplicate of an allowed one is refused (`:87,209-219`). Response headers: `content-type`, `x-codex-turn-state`, `retry-after` (`:27`).
- Limits: request 16 MiB, response 64 MiB, LLM 11 minutes, MCP 20 minutes (`:30-39`).

For the driver this means: `llm.baseUrl` is `http://sandbox-gw:8080/<prefix>` and the CLI appends its own path (`/chat/completions` for `@ai-sdk/openai-compatible`), so the gateway needs one more exact path and the role `llm` a backend route with the same path (today `LlmBackend.routes`, e.g. `packages/llm-backends/src/kimi-code/backend.ts:173`). The existing Kimi body policy is a closed schema (`packages/llm-backends/src/kimi-code/body.ts:73-92`): the new backend's policy has to be written from what OpenCode really sends (sampling parameters, `max_tokens`, thinking fields, the title request), which is the gateway map's subject.

## 8. Stands that run a real CLI

| Stand | What it runs [repo] | For OpenCode |
| --- | --- | --- |
| `pnpm verify:codex` (`packages/agent-drivers/scripts/verify-codex.mjs`, CI `codex-driver.yml` job `verify-codex`) | real driver + CLI in runtime-image containers, `--network none`, LLM and MCP fakes on loopback inside the container (`:490-521`), hostile project config (`:531-551`), two turns, the second in a new container with only the session files (`:455-458,556-557`) | a twin `verify:opencode`: chat-completions fake with tool rounds, MCP fake, hostile project set (the probe's `scripts/plant.sh` is a ready list: `opencode.json`, `.opencode/{agent,plugin,command,skill}`, `AGENTS.md`, `CLAUDE.md`), checks: no `auth.json`, snapshot = db + wal only, keys invisible to commands, `-` and a 70 000-character prompt, attachment listing, current instructions on resume, version string |
| `pnpm verify:codex-supervisor`, `verify:kimi-supervisor` (`verify-agent-supervisor.mjs` → `verify-runner.mjs --codex|--kimi`, `codex-runner-fixture.mjs`, `kimi-runner-fixture.mjs`) | supervisor → remote executor → pull runner → sandbox under `runsc` → real `sandbox-gw` → synthetic LLM/MCP on the host; encrypted snapshots, restore, trusted publication, gitleaks | `--opencode` mode and `opencode-runner-fixture.mjs`. The Kimi fixture is already a chat-completions + MCP fake with the phases shell → MCP → result (`kimi-runner-fixture.mjs:323-355`); to change: route, model, effort field, tool names (`bash`, `raditi_site_info`), the shell check (`opencode --version`), the title request, native id pattern (`ses_…`), expected home (`verify-runner.mjs:798-830`), journaled event types (`:855-857`), hostile seed (`:681-701`), published tree (`:885`). This is also the first proof under gVisor |
| `pnpm verify:runner` (`verify-runner.mjs` without a flag, `verify-runner-core.mjs`) | P2 crash scenarios with a synthetic agent that **prints Codex JSONL** and uses `createCodexDriver` for parser, session state and result, home `/agent-home/codex` (`verify-runner.mjs:5,71`, `verify-runner-core.mjs:34-81`) | no real CLI, but it dies with the Codex driver: the synthetic agent must print another driver's format |
| `pnpm verify:llm-gateway` (B13: `verify-llm-gateway.mjs`, `-drivers`, `-stream`, `-protocol`, `-lifecycle`, `-crashes`; `infra/dev/llm-verify/{cli.mjs,cli.Dockerfile,fake-subscriptions.mjs,compose.yml,stack.mjs}`) | CLI image built on the runtime image; turns through the drivers' `prepare` + `command` (`verify-llm-gateway-drivers.mjs:132-196`); exec and resume per CLI in one container; stream failures (`-stream`); hand-written CLI configs for protocol and lifecycle scenarios (`cli.mjs:24-126`) | driver entry and endpoint in `-drivers` (`:25-32,138`); a Z.ai fake provider beside or instead of the two (`fake-subscriptions.mjs:44-47`, alias list `compose.yml:54`); a hand-written OpenCode invocation or a move of those scenarios to `runPrepared`; request counts change if the title request stays |
| `pnpm verify:agent-content` (`verify-agent-content.mjs`, `-turns`, `-role`; CI `agent-content.yml`) | both CLIs edit a page of a real WordPress through `sandbox-gw`, role `llm` on fakes, real role `mcp`; key from the real `issue` | per-driver table (`verify-agent-content-turns.mjs:26-36`), tool declaration and tool output readers per wire format (`:56-90`; OpenCode is chat-completions, like Kimi), account import and driver enabling for the new backend (`verify-agent-content.mjs:190-236,270-271`), scenario model for the new provider path |

Stands without a CLI (`verify:mcp-content`, `verify:site`, `verify:gitea`, `verify:publication`, `verify:db`, `verify:vault`, `verify:edge`, `verify:llm-app`, `verify:llm-firewall`, `e2e`) do not depend on the driver; `verify:llm-app` names backend routes (`infra/app/verify-llm-app.mjs:592,610`).

## 9. Code written for Codex or Kimi by name

**Supervisor, sessions, runner, executor — clean.** `git grep -i 'codex|kimi'` over `apps/orchestrator/src` outside `llm-gateway/`, `llm/` and `subscriptions/`, without tests, finds only:

| Place | What | Kind |
| --- | --- | --- |
| `apps/orchestrator/src/drivers/drivers.module.ts:9` | `ENABLED_AGENT_DRIVERS = ['codex','kimi']` | composition root; a second source of truth beside `agent_drivers.enabled` |
| `apps/orchestrator/src/turns/turn-output.ts:33` | «one Codex event» | comment |
| `apps/orchestrator/src/mcp/mcp-auth.guard.ts:61` | «Codex server/discover» | comment |
| `apps/orchestrator/src/testing/runner-sandbox.ts:34,37,139,158`, `testing/turn-credentials.ts:38` | image name, `/agent-home/codex`, `driverId: 'codex'` | shared test helpers |

No branch on a driver id exists there: the code uses `driver.id`, `plan.driverId`, `input.driverId` (`turn-supervisor.ts:76,215`, `turn-exec-recovery.ts:271,424`, `local-turn-executor.ts:80,156`).

Named elsewhere, and what follows for the pivot:

1. **Domain enums.** `agentDriverIds = ['codex','kimi','qwen','opencode']` (`agent-driver.ts:15`) and `llmBackendIds = ['openai-chatgpt','kimi-code']` (`llm-backend.ts:4`) are closed lists inside zod schemas of stored data: the turn plan (`turn-executor.ts:331`), the key grant (`turn-credential-grant.ts:14-15`), the runner protocol (`runner/protocol.ts:228,246`), the snapshot manifest (`snapshot-manifest.ts:32`). Removing an id makes stored plans and manifests with that id unparseable, and `agent_drivers` rows are referenced by turns, sessions, usage, accounts and keys (`schema.prisma:850-868`). Rows are disabled, not deleted; the id lists shrink only when no stored data names the id.
2. **Tests use `codex` as «the driver».** 24 test files under `apps/orchestrator/src` outside the gateway directories mention Codex or Kimi, 20 of them with the literal `'codex'`, `/agent-home/codex` or the `raditi/codex@sha256` image (`turn-supervisor.test.ts` 28 mentions, `local-turn-executor.test.ts` 18, `remote-turn-executor.test.ts` 12, …). They take Codex as the neutral example and break together when the id leaves the enum. A neutral test driver would have avoided it.
3. **Shared stand code branches on the CLI name**: `verify-agent-supervisor.mjs:414-416`, `verify-runner.mjs:56-72,543-560,666,681-701,792-830,855-857,885`, `verify-runner-core.mjs:69-81,204` (`backend: driver.id === 'kimi' ? 'kimi-code' : 'openai-chatgpt'`), `verify-llm-gateway-drivers.mjs:25-32,114-126`, `verify-agent-content-turns.mjs:26-36,56-90,313`, `infra/dev/llm-verify/cli.mjs:66-126`. One profile object per driver (fixture, model, efforts, base URL, version, id pattern, expected home, expected events, hostile seed) instead of ternaries keeps the next change local.
4. **The synthetic P2 agent speaks Codex** (`verify-runner.mjs:5,71`, `verify-runner-core.mjs:34-81`).
5. **Trusted infrastructure names both CLIs**: `infra/sandbox/gateway.mjs:17-19,27,68,112-114,221-232` (paths, Codex headers, `x-msh-*`), `infra/sandbox/Dockerfile:1,11,22-29`.
6. **Inside the adapter package** (allowed by rule 8, still to touch): `registry.ts:21-36`, `drivers.test.ts:104`, `cli-lock.test.ts:27-31`, the result contract text in `kimi.ts:31-35`, comments in `cli-run.ts:10`, `output-schema.ts:95-100`, `agent-driver.ts:30`.
7. **Seed and schema comments**: `seed/data.ts:154-179`, `schema.prisma:567,908,1004`.

## 10. Open points, in the order they block

1. The binary under `runsc` (start, a turn, SQLite, child processes).
2. Key channel (section 5.3): which option keeps both values out of tool commands' reach, proven by the fixture's shell check.
3. Resume in a new container from `opencode.db` + `opencode.db-wal` only; same session id; history present in the provider request.
4. Start without network: the background `npm install` (the `models.opencode.ai` attempt is silenced by the probe's hardened config).
5. `OPENCODE_DISABLE_PROJECT_CONFIG` on a real turn: no planted instructions, agent, MCP server or plugin in the request or the process (shown so far on `debug config`, `agent list` and `debug skill`); whether `AGENTS.md` and `CLAUDE.md` of the repository are still read; whether `.opencode/.gitignore` is still written.
6. What `--variant low|high|max` puts into the request body for a custom provider, and whether the built-in `zai-coding-plan` handling applies to a provider with another id.
7. Title request: removed by `--title`, or kept and allowed by the gateway.
8. Retries: which statuses and in-stream errors OpenCode repeats, how many times (the probe's `37-err-*` runs were starting).
9. MCP: a failed connection must fail the turn; request timeout value.
10. Result discipline of GLM without a schema flag beyond the first three turns.
11. Image: size on x64 (one or two binaries), the fixed binary path.
