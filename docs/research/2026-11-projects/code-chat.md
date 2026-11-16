# Server side of a chat pass in `raditi-noprojects` (post plan 83): where a new "project" plugs in

Tree: `raditi-noprojects`, branch `feat/remove-projects`, HEAD `02c32c4d`. All paths below are relative to that tree unless they are prefixed `origin/main:` or `raditi-sched/`. I edited nothing.

## Facts

### 1. Creating a chat (tRPC)
- **`task.create` input** (`packages/trpc/src/routers/task.ts:125-145`): `{ taskId (UUID from the browser), text, attachments?, effort? }`. It has no project field. Every other procedure (`message`, `remove`, `list`, `search`, `get`, `commands`) works by `taskId` or by user (`task.ts:147-446`).
- **`createDialog`** (`packages/trpc/src/services/chat/tasks.ts:141-215`), in order:
  - checks that the id is UUID v7 (`UUID_V7`, `:110`);
  - finds the personal workspace with `personalWorkspaceOf` (`services/chat/dialog-lock.ts:24-28`, which calls `ensurePersonalWorkspaceWithGift`);
  - fixes `needsBrowser` from `browserConfigured` (`services/chat/context.ts:78-79`);
  - makes the Transit key `ws-<id>` before the transaction (`tasks.ts:117-124`);
  - in one transaction: `task.createMany` with `workspaceId, createdById, status 'queued', modelClass, billable, title, needsBrowser` (`:175-189`), `placeCreditHold` (`:195-201`), `bindMessageAttachments` (`:202-207`), the `feed.request` row (`:208-211`), and `enqueueAgentTurn` (`:212`).
  - A leftover constant `NO_SITE = { siteId: null }` sits at `tasks.ts:65`.
- **Other callers of `createDialog`:**
  - Telegram intake (`packages/trpc/src/services/telegram/intake.ts:381`).
  - Plan 82 calls it too, with `siteId` and `title`/`preview` options (`raditi-sched/docs/plan/82-scheduled-tasks.md:69, :244`).
- **Access to a chat:**
  - `accessibleTask` is "member of the workspace and not deleted" (`services/chat/access.ts:9-14`).
  - `lockTask` hard-codes `repository: false` (`access.ts:55-80`).

### 2. Schema (`packages/db/prisma/schema.prisma`)
- **`tasks`** (`:388-482`): workspace, chat session, author, status, class, attempt, `turnNo`, title and `titleSource`, `needsBrowser` (fixed by a trigger), `deletedAt`, `pinnedAt`, `archivedAt`. It has no site or project column. Indexes are by workspace: `tasks_workspace_updated_idx` and the pinned index (`:473-481`). The trigger `tasks_requirements_fixed` and `tasks_chat_id_check … NOT VALID` are in `migrations/20261116110000_remove_projects/migration.sql:39-41, :527-529`.
- **`chat_sessions`** (`:357-384`): per channel. Only Telegram writes it (`apps/core/src/telegram/telegram-jobs.ts:411+`, `intake.ts:337-462`).
- **`task_turns`** (`:516-556`): `nativeSessionId`, `snapshotPrefix`, `undoneAt`. The leftover columns `base_sha` and `head_sha` are still there (`:534-535`).
- **`turn_assignments`** (`:572-605`): `site_id` holds the chat id (`:576`). The whole plan JSON, instructions included, is stored in `plan` (`:582`).
- **`site_leases`** (`:290-306`): one row per chat, keyed by chat id.
- **`attachments`** (`:770-797`): `task_id` is set only while the status is `bound`. Two CHECKs (`migrations/20261022100000_browser_tasks/migration.sql:63-69`):
  - `attachments_bound_check`: bound ⇔ `task_id` set;
  - `attachments_key_check`: `s3_key = 'inbox/<ws>/<id>'`.
- **`agent_instructions`** (`:755-763`): one row per user, 1–2000 characters. The procedures are `user.agentInstructions` and `setAgentInstructions` (`packages/trpc/src/routers/user.ts:29-60`; `looksLikeSecret` check at `:48`).
- **`workspaces`** (`:163-192`) has `dataClass`. Also: `workspace_env_vars` (`:2170-2186`), `workspace_agent_skills` (`:2191-2215`), `page_reservations` (`:1988-2012`), and `chat_documents` (`:2016+`, belongs to the workspace — "any chat of it may write it").
- **`plans`** (`:1181-1217`): `creditsPerMonth`, `tasksPerDay` (unused), `creditsPerDay`, `packCredits`, `creditsPer5h`, `creditsPerWeek`, `pageSites`, `pageCustomNames`. `max_sites` is gone (plan 83, БП8).

### 3. How `core` builds a pass
- **Flow:** `PassRunner#plan` (`apps/core/src/tasks/pass-runner.ts:397-417`) → `readPassFacts` (`pass-facts.ts:49-202`) → `planTurn` (`turn-planner.ts:403-528`).
- **What the facts read:**
  - the task, with `workspace.agentSkills` and `createdBy.agentInstructions` (`pass-facts.ts:54-74`);
  - requirements fixed to `{repository:false}` (`:77`);
  - the `feed.request` rows (`:78-110`);
  - variable names only (`:129-137`);
  - attachments (`:181`), `clientInstructions` (`:191`), skills (`:197`).
- **What the plan sets:**
  - `sessionId = task.id` (`turn-planner.ts:448`);
  - sandbox label `siteId: task.id` (`:461`);
  - network: gateway plus internet (`:471`);
  - the instructions string, `openTaskInstructions(...) + CHAT_TITLE_SECTION + requestedFormatsSection + clientInstructionsSection` (`:486-490`);
  - inbox paths (`:509`);
  - continuation from the previous snapshot (`startOf`, `:385-397`).
- **Instruction texts** (`apps/core/src/tasks/turn-instructions.ts`):
  - `OPEN_RULES` says "The working directory is empty and nothing you write there is kept" (`:249-258`);
  - `openTaskInstructions` (`:288-305`), `variablesSection` (`:192-202`), `internetSection` (`:229-247`), `UNSEEN_IMAGES` (`:172-173`).
- **`clientInstructionsSection`** (`packages/domain/src/agent/client-instructions.ts:5-18`): wraps the text in `<client-instructions>` and marks it as data, not platform rules; the limit is 2000.
- **Limits:** prompt 100 000 characters, instructions 256 KiB (`packages/domain/src/ports/turn-executor.ts:356-361`).
- **How OpenCode gets the instructions:**
  - The driver rewrites `~/.config/opencode/AGENTS.md` from `context.instructions` every turn; the CLI re-reads it on every request (`packages/agent-drivers/src/opencode.ts:44-46, :419-421`).
  - Several `OPENCODE_DISABLE_*` switches are set, among them `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` (`opencode.ts:110-118`).
  - Project files in the working directory (`.opencode`, `opencode.json`) are hidden by the wrapper (`opencode.ts:88-96`; `opencode-wrapper.ts:303-330`).
  - So an `AGENTS.md` in the working directory is never read. Every bit of project context must come through `context.instructions` or through files.
- **End of a turn:** documents are settled with `refusesText` (secret / client-value check) at `pass-runner.ts:352-353`, files are delivered at `:367-372`, page changes are applied at `:375-376`. `refusesText` comes from the completed run (`:325-331`).

### 4. How attachments reach the sandbox
- **Upload:** `attachment.start` (`packages/trpc/src/routers/attachment.ts:33-46`), then `PUT /api/attachments/[id]` into `raditi-inbox` under `inbox/<ws>/<id>` (`packages/domain/src/attachments/rules.ts:338-342`).
- **Rules:**
  - Allowed types: jpg, png, webp, gif, pdf, docx, xlsx, pptx, odt, ods, txt, csv (`rules.ts:48-126`). There is no md, json, html, code or zip.
  - 20 MiB per file, 10 per message (`rules.ts:19-30`).
  - A file nobody sent is kept 24 h (`packages/db/src/attachments.ts:21`).
- **Binding:** `bindAttachments` requires `ready`, `task_id IS NULL`, uploader = user, same workspace (`db/src/attachments.ts:110-140`).
- **Into the pass:**
  - `taskAttachments` (`:216-224`) feeds `turnInboxOf`, which takes the latest files, at most 50 files and 200 MiB (`turn-planner.ts:304-316`; `turnInboxLimits`, `turn-executor.ts:400-403`).
  - Path: `/workspace/inbox/<id>/<name>` (`turnInboxPath`, `:412-416`).
  - Gate: `turnMayHoldInbox` requires `labels.siteId === labels.taskId` (`:432-433`).
- **Placement:**
  - The supervisor re-checks every file's binding to the task (`TaskInboxFiles`, `apps/core/src/turns/turn-inbox.ts:26-56`; `turn-supervisor.ts:202-206`).
  - The executor writes them read-only (0444) after the restore (`packages/local-turns/src/inbox.ts:26-35`; `local-turn-executor.ts:152`).
  - A remote runner pulls each file from `core` with `GET …/inbox/<place>` (`apps/core/src/runner-api/runner-api.server.ts:234-243`; `packages/domain/src/runner/protocol.ts:61-65, :237-242`). Each file is read from S3 every turn; nothing is cached.
- **Browser worker:** it reads only attachments bound to the task (`apps/browser/src/store/worker-store.ts:177`).

### 5. What the sandbox workspace looks like now
- **Paths:** `/workspace/repo` (working dir), `/workspace/inbox`, `/workspace/out`, `/agent-home` (`packages/domain/src/ports/agent-driver.ts:39-42`).
- **Empty working dir:** `makeEmptyWorkdir` refuses a working directory that is not empty (`packages/local-turns/src/empty-workdir.ts:12-23`). It runs before the restore and the inbox (`local-turn-executor.ts:145-152`).
- **tmpfs sizes:** `/workspace` 512 MiB, `/agent-home` 256 MiB, `/tmp` 64 MiB (`packages/sandbox-providers/src/docker.ts:56-63`).
- **Capture at the end of a turn:** only home plus the outbox (`local-turn-executor.ts:428-430`; `turn-executor.ts:213, :244`).
- **Git:**
  - The sandbox image **has `git`**, plus curl, jq, ripgrep, fd, php-cli, composer and python3 (`infra/sandbox/Dockerfile:25`).
  - The **`core` image has no git or gitleaks** (`apps/core/Dockerfile:45-47`).
- **Network:** the agent's commands get `HTTPS_PROXY` and `HTTP_PROXY` (`opencode-wrapper.ts:444-445`). The egress proxy opens only TLS on ports 443 and 8443 (`infra/sandbox/client-egress.mjs:95-96`). So git works over HTTPS only, never SSH, and private addresses are refused.

### 6. Snapshots
- **Parts:** `home`, `untracked`, `patch`. A turn without git keeps `home` only (`packages/domain/src/sessions/snapshot-manifest.ts:15-21, :100-108`). The git part of the schema is still there.
- **Limits:** archive 16 MiB, expanded 128 MiB, 10 000 entries (`sessions/session-state.ts:6-15`).
- **What the driver keeps:** only `opencode.db` and its WAL (`opencode.ts:75-80, :561-563`).
- **Key and encryption:** `sessions/<chatId>/turns/NNNN/` (`snapshot-manifest.ts:187`), sealed with Transit `ws-<workspaceId>`.
- **Consequence:** one OpenCode session per chat; nothing is shared between chats.

### 7. Variables and skills
- **Variables:**
  - Names go into the facts. Values are read from Vault at the version each row names, inside the turn credentials (`apps/core/src/llm/turn-credentials.ts:367-405, :884-892`; `apps/core/src/workspace-env/workspace-env-values.ts:22-36`).
  - They reach the agent's commands only through `BASH_ENV` (`opencode.ts:81-85`; `opencode-wrapper.ts:683`).
  - Gate: `workspaceEnvVarsReachAgent` (`packages/domain/src/workspace-env/env-vars.ts:49-50`). Vault path: `env-vars.ts:26-30`.
- **Skills:**
  - `turnSkillsOf` (`packages/domain/src/agent/skills.ts:227-250`) gives the built-ins context7 and playwright plus the added servers.
  - A server's secret lives at `kv/workspaces/<ws>/mcp/<name>` (`skills.ts:256-257`).
  - The relay finds a server by the turn's workspace (`apps/mcp/src/skill-relay/skill-servers.ts:37-45`).
  - A generic MCP OAuth flow already exists: RFC 9728, 8414 and 7591 (client registration), with PKCE (`apps/web/src/server/mcp-oauth.ts:11-15`).

### 8. The pages/docs pattern, as a template for memory tools
- **`mcp` side:**
  - `McpPagesService`: reads answer at once; writes are reserved and applied by `core` at the end of the turn (`apps/mcp/src/pages/pages-service.ts:23-31`; store interface `:51-98`; `publish` `:129-176`).
  - Wiring: `pages.module.ts:21-54`. The module is registered conditionally (`apps/mcp/src/app.module.ts:45-50`).
  - Every tool call must be allowlisted with its argument schema (`apps/mcp/src/access/mcp-policy.ts:80` and others). The MCP body limit is 100 KiB (`:40`).
  - The turn scope comes only from the token, never from arguments (`mcp-access.ts:12-23`; admission SQL `:42-59`).
- **Permission:** `authorManages` — the chat's author must be owner or admin (`packages/db/src/pages.ts:1285-1293`, used at `:1361`).
- **`core` side:**
  - `PageChanges.apply` reads `pendingPageChanges` (`db/src/pages.ts:1426`) and applies each change in order; a change that fails is refused alone and told in the feed (`apps/core/src/tasks/page-changes.ts:53-80`).
  - It runs only for a completed turn whose answer was settled, and with `refusesText` (`pass-runner.ts:375-376`).
  - Reservations wait in `page_reservations` with `outcome IS NULL` until then.

### 9. Chat list, grouping and deletion
- **List:**
  - `listDialogs` builds pages with `dialogPageQuery`: a lateral join per workspace of the user, the latest changed first (`packages/trpc/src/services/chat/dialog-list.ts:99-159`); pinned chats come from `pinnedQuery` (`:205-213`).
  - There is no grouping now; plan 83 removed «По проектам».
  - List items carry title, status, `answered`, `rewound`, `failed`, `pinned`, `archived`, `telegram`.
- **Deletion:** `removeDialog` is a soft delete (`deleted_at`): it stops a running pass first and forgets the Telegram topic; a repeat is safe (`services/chat/dialog-manage.ts:162-196`).

### 10. Limits by tariff
- `plans.page_sites` was added with a data migration (`migrations/20261115220000_plans_page_sites`).
- It is read through the live subscription (`siteLimitOf`, `db/src/pages.ts:232-239`). Without a paid tariff the default is `pageLimits.sitesWithoutTariff = 1` (`packages/domain/src/pages/limits.ts:26`).

### 11. Vault policies (`infra/vault/policies/*.hcl`, `infra/vault/README.md:9-19`)
| Role | Policies and what they allow |
| --- | --- |
| web | `sites-writer`: create/update `kv/data/workspaces/+/env/*` and `+/mcp/*`, metadata with `max_versions=1` only, no read back. `workspace-provisioner`: create `transit/keys/+`. |
| core | `core-turns`; `core-transit` (`ws-*` data key and decrypt); `core-workspace-env` (read `kv/data/workspaces/+/env/*` only). |
| mcp | `mcp-content`: read/update `kv/data/workspaces/+/mcp/*`, content masks, `subs/data/search/yandex`. |

No policy covers any `kv/workspaces/<ws>/projects/*` or `git/*` path.

### 12. What is left of "project/site" in the domain
- **Gone:** `chatRequirements` and `siteIdOf` match nothing anywhere.
- **Still there:**
  - `leaseScopeOf` and `turnLeaseOf` both return `task.id`; the errors `siteBusy` and `siteHeld` remain (`packages/domain/src/ports/turn-runner.ts:15-24, :50-55`).
  - `TaskRequirements.repository` exists but is always false (`tasks/task-requirements.ts:10-34`; `pass-facts.ts:77`; `access.ts:80`; `apps/mcp/src/access/mcp-access.ts:21`).
  - A stale default `REPOSITORY_ONLY` in `feedTaskHeadSchema` (`tasks/client-feed.ts:1544`).
  - `feedSiteOf` and `feedEndedSiteOf` take `{siteId: string | null}` (`client-feed.ts:228-244`).
  - `site_info` returns `stack`/`url` null (`apps/mcp/src/site-info/mcp-tools.controller.ts:26-39`).
  - Sandbox label `siteId` (`sandbox-providers/src/docker.ts:55`).
- **Git port intact:** the **`GitProvider` port** is unused but complete (`ports/git-provider.ts`, 188 lines). Its methods are at `:125-179`: `getRepository`, `issueCredentials`, `openPullRequest`, `getPullRequest`, `mergePullRequest`, `closePullRequest`, `setActionsSecret`, `deleteActionsSecret`, `setActionsVariable`, `protectTags`, `createTag`, `getTag`, `listWorkflowRuns`, `getWorkflowRun`, `dispatchWorkflow`. Webhook event types are there too. `policies/diff-paths.ts` (`forbiddenCiPaths`, `isForbiddenPath`) is exported but used by nothing.
- **On main, for reference:**
  - The GitHub and GitLab adapters were **stubs that throw NOT_IMPLEMENTED**; only Gitea was real (`origin/main:packages/git-providers/src/gitlab.ts`, `stub-provider.ts`).
  - The trusted publication lived in `origin/main:apps/core/src/git-workspace/*`; the repository bundle was limited to 64 MiB (`origin/main:packages/domain/src/git/publication.ts:21`).
- **Dead queue names:** `queueNames` still lists `deploys`, `site-provisioning`, `site-import`, `previews` and `site-files` (`packages/domain/src/ports/job-queue.ts:7-26`).
- **Web:**
  - The rail links «Проекты» to `/projects` (`apps/web/src/components/application/application-rail.tsx:19`), and `robots.ts:22` disallows it; no such route exists.
  - The composer still has a `mentions` prop with no source, because `siteFiles` is gone (`components/chat/composer.tsx:167, :262`).
- **Plan 82 conflicts:**
  - Its migration `20261116120000_scheduled_tasks` has the **same timestamp** as plan 83's `20261116120000_credential_kind_mcp_server_workspace`.
  - It adds a foreign key `site_id → sites`, but that table is dropped (`raditi-sched/docs/plan/82-scheduled-tasks.md:193-210, :324`).

## Implications for Raditi projects
1. **`tasks.project_id`.**
   - A nullable foreign key to `projects`, fixed after creation by a trigger in the style of `tasks_requirements_fixed`.
   - An index `(project_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL`.
   - `createDialog` gets `projectId?`, checks that the project is in a workspace the user belongs to, and uses the project's workspace instead of `personalWorkspaceOf`.
   - Telegram passes null. Plan 82 swaps `siteId` for `projectId` and renames its migration.
   - Add `projectId` to `LockedTask`, to the `readPassFacts` select, to `listDialogs({projectId})` and its items, and to the feed head.
   - Keep the lease per chat. A project-level lease would break `turnMayHoldInbox` (`siteId === taskId`) and stop chats of one project running in parallel.
2. **Project instructions.**
   - Add a `projectInstructionsSection` in the same data-tag pattern as `clientInstructionsSection`, inserted in `turn-planner.ts:486-490`.
   - Validate with `looksLikeSecret`.
   - The text is persisted in `turn_assignments.plan`. Because `AGENTS.md` is rewritten every turn, an edit takes effect from the next turn, even in a resumed session.
   - Keep the total well under 256 KiB.
3. **Project files.**
   - Storage: a new table, say `project_files`, rather than overloading `attachments`. Three things in the current design fight it: `attachments_bound_check`, the collector that deletes unsent files after 24 h, and the browser worker's binding to a task. Keys stay in `raditi-inbox` (for example `projects/<ws>/<project>/<id>`); no new bucket.
   - Delivery: generalise `TurnInbox` / `TaskInboxFiles` and the runner `inbox` place to a second root, say `/workspace/project/<id>/<name>`, re-checked against the task's project.
   - Budget: the 512 MiB `/workspace` is shared with the inbox (up to 200 MiB). Files are re-read from S3 every turn.
   - The allowed types need widening (md, json, html, code) for context to be useful.
   - Pasted text content can become a stored `.md`.
4. **Memory.**
   - Store it in PostgreSQL: a project memory table and a per-user one for «Использовать память аккаунта».
   - Write path, same as pages: `mcp` tools `memory_*` reserve during the turn, and `core` applies them at the end of a completed turn after `refusesText`, so no secret or variable value is stored.
   - Read path: a bounded section of the instructions.
   - OpenCode itself has no memory across chats here: the snapshot is per chat, and project and Claude files are disabled.
   - An "after a few sessions" summary would be a `core` job reusing the `/compact` path (`opencode serve`), as a paid pass.
5. **Repository.** Three options, cheapest first:
   - **A. In-sandbox git.** git and an HTTPS proxy are already there; the token is a variable delivered by `BASH_ENV` and masked. Each turn clones into the empty working dir and must push before it ends, because nothing persists. Editing CI files is allowed, since rule 6 is history in this tree.
   - **B. Trusted path.** `core` holds an OAuth token in Vault, git comes back into the `core` image, and the repository arrives as a bundle. A real GitLab adapter for the intact `GitProvider` port does merges, CI variables and pipelines (`listWorkflowRuns`).
   - **C. GitLab or GitHub MCP server as a workspace skill** with plan 81 OAuth; no new Vault policy. Skills are per workspace, not per project, and the official servers' readiness must be checked.
   - A and B each need new Vault paths and policies (web write, core read).
6. **Limits and deletion.**
   - A `plans.projects` column following the `page_sites` migration pattern, plus a storage limit.
   - Delete a project with a trash and `purgeAfter`, like pages.
7. **Cleanups to do alongside:** the dead queue names, the `REPOSITORY_ONLY` default, `NO_SITE`, `site_info`, `base_sha`/`head_sha`, and the dead `/projects` rail link.

## Questions for the owner (proposed defaults)
1. **Which workspace owns a project?** Default: the user's personal workspace; members see it.
2. **Chats without a project, and moving chats between projects.** Default: chats without a project stay; a chat's project is fixed when it is made.
3. **Length of project instructions.** Default: 8000 characters, with the same secret check. They come after the platform rules; the account instructions still apply.
4. **Context files.** Default: 100 files and 100 MiB per project, 20 MiB each; add md, json, html, yaml and text code to the allowed types; delivered read-only every turn.
5. **Text content.** Default: kept as a `.md` file of the context and counted in the limits.
6. **GitHub link.** Default: a public repository is cloned by its link; a private one needs a linked account.
7. **GitLab account.** Default: a Personal or Project Access Token stored as a project secret and given to the agent's commands (option A); OAuth later; private addresses refused.
8. **Merge and deploy.** Default: the agent opens a merge request; it merges to the default branch only when the client asks for that in the chat; editing CI files is allowed and the agent says so in its answer.
9. **Memory.** Default: project memory on, written by the agent through tools and shown in «Память», where the client can edit or clear it; account memory off.
10. **Scheduled tasks.** Default: rebuild plan 82 on projects; a run opens a chat in its project.
11. **Projects per tariff.** Default: no limit on the number; storage limited per project.
12. **Deleting a project.** Default: it goes to the trash for 30 days together with its chats, and they come back with it.
