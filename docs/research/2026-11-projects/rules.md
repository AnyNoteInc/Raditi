# Audit: Claude-style projects against Raditi's non-negotiable rules (state on 15.11.2026)

Paths are relative to `raditi-noprojects` (branch `feat/remove-projects`, plan 83) unless marked `[sched]` (`raditi-sched`, plan 82) or `[main]` (`git show origin/main:`). Line numbers are in the original files.

## 0. Baseline: what plan 83 left in place

**Rules text after plan 83 (`CLAUDE.md`)**
- Plan 83 edited only rules 2, 3, 4 and 6 (`git diff cef48b03 HEAD -- CLAUDE.md`).
  - Rule 3 (`:254`) and rule 6 (`:257`) now say *«правило — история»*. Rule 3 keeps one part: the agent changes external sites only with `web_*`, and the platform promises no rollback.
  - Rule 4 (`:255`): *«агента в браузере держат инструкции хода»*.
- Rules 1, 5, 7 and 8 were not edited, so they are now stale in places.
  - Rule 5 (`:256`) still ends *«коммит и push делает доверенная сторона»*. That trusted side no longer exists.
  - Rule 8 (`:259`) still lists `GitProvider`, `SiteAdapter`, `PreviewRuntime`, `HostingWriter` and `SiteDbGateway`.
- The «Расхождения» entry «Выкладка для сайтов в GitHub или GitLab клиента … `GitProvider` …» is still there (`CLAUDE.md:317`).

**Spec after plan 83 (`docs/spec.md`)**
- The banner at `:7` says that §§1, 7, 8 and 10–13, 15, 16 and 19 are history wherever they talk about sites, git or releases. What is in force is §20 «Без проектов» (`:4059-4077`, БП1–БП11).

**Git and the trusted side are gone in code**
- `apps/core/Dockerfile:45`: *«No git and no gitleaks since a turn has no repository»*.
- `packages/domain/src/ports/turn-executor.ts:464-467`: the turn plan schema refuses a repository turn (`workspace`, `replacesTurn`, `rebased`).
- Without a repository `/workspace/repo` is an empty folder. *«что агент там напишет, не сохраняется»* (spec `:595`). The snapshot holds only `home` (spec `:647`). The warm sandbox's `reset` clears tmpfs.
- **A repo cloned inside the sandbox does not survive to the next turn.**

**Leftovers**
- The `GitProvider` interface still sits in `packages/domain/src/ports/git-provider.ts:123-187`, which includes `openPullRequest` and `mergePullRequest(ref, n, expectedHeadSha)`.
  - It is not exported from `packages/domain/src/index.ts`. The file's only live user is `gitProviderKinds` in `packages/domain/src/sessions/snapshot-manifest.ts:5`.
  - The adapters (`packages/git-providers`) are deleted.
- The CI-path policy `forbiddenCiPaths`/`isForbiddenPath` (`packages/domain/src/policies/diff-paths.ts:12-16,80`) is still exported (`index.ts:38`). No product code calls it.

**Open internet already reaches the sandbox**
- The proxy allows CONNECT to any public name on 443 and 8443 (rule 5 `:256`; spec `:604`): *«публичный git-provider достижим через прокси выхода, как любой сайт»*.
- The image has `git` (`infra/sandbox/Dockerfile:25`). So the agent can already `git clone https://github.com/<public>` in a turn; SSH on port 22 is closed.

**Workspace variables already put long-lived client secrets into the agent's bash (БП4)**
- Every chat of the workspace gets every variable, with no flag (spec `:4068`). Code: `apps/core/src/workspace-env/workspace-env-values.ts:22-36`.
- The agent is told *«Send a value only to the service the client named it for»* (`apps/core/src/tasks/turn-instructions.ts:192-202`).
- Only the `GIT_` prefix is reserved (`packages/domain/src/release/env-vars.ts:26`). A variable named `GITLAB_TOKEN` passes.
- **So a client can already hand the agent a GitLab or GitHub PAT, and the agent can push from inside the sandbox.** That bypasses gitleaks, the CI-path policy and the trusted push. This is the main hole to close or accept explicitly.

**Precedents worth reusing**
- **Plan 81 key relay (КМ1–КМ6, spec `:4041-4050`)**
  - The secret lives in Vault `kv/workspaces/<ws>/mcp/<name>` and is injected by `apps/mcp/src/skill-relay`. The sandbox never sees it.
  - OAuth uses PKCE, dynamic client registration (RFC 7591) and an encrypted attempt cookie.
  - Token renewal runs under `pg_advisory_xact_lock` with CAS writes.
  - SSRF is guarded by `publicAddressCheck` plus `SANDBOX_EGRESS_REFUSED_SUBNETS`.
- **Yandex sign-in:** *«токены Яндекса в `accounts` не хранятся (правило 2)»* (spec `:2183`). So linking an OAuth account through better-auth's `accounts` table is not acceptable.
- **The trusted release skill:** *«не навык агента … текст модели разрешением не считается»* (spec `:1268`). It uses an HMAC `confirmToken` bound to the exact description shown to the client.
  - The `confirmedByClient: true` argument of the page tools is only the model's own claim (`apps/mcp/src/pages/pages-arguments.ts:108-117`).
  - `request_approval` is still not built (`packages/domain/src/browser/checkpoint.ts:45`).
- **Secret-like text is refused** in messages (spec `:1387`) and in user instructions (plan 76 И3, `[main] docs/plan/76-agent-instructions.md:18`).
  - User instructions go into every pass as a data section that cannot widen permissions (И2, `:17`).
- **152-ФЗ gate in production is passed:** the owner wrote `cross_border_clearances` for `zai-coding` without a lawyer (С9, spec `:3582`).
  - So client data, project files and repository code included, does reach Z.ai in production.
  - The owner has no lawyer (08.11.2026), so «спросить юриста» items go to the owner.

## 1. Each part of the request against the rules

### A. Project files, text context and «Инструкции» sent to the model

**Rules touched:** 1, 2, 7, 10, and the bucket list in the coding rules (`CLAUDE.md:279`).

**What plan 83 changed:** nothing; chat attachments work as before.

**Conflicts**
1. **Rule 1 holds, if the data is stored first.** Files must go to S3 in Russia before any turn, and they are client data under the gate (already true for attachments, spec `:1525`).
2. **The storage itself does not fit project files.**
   - `raditi-inbox` has a 90-day lifecycle (spec `:1523`), but project context must live as long as the project.
   - A new bucket is not allowed without a spec change: only the six `raditi-*` buckets are permitted.
   - The sandbox limits are 50 files and 200 MiB per turn (`turnInboxLimits`) and a 512 MiB tmpfs for `/workspace` (spec `:664`).
3. **Text context and instructions skip secret checks.** They go into the prompt every pass, but nothing checks them for secrets yet.
4. **Cost.** Every pass re-sends them, so every pass costs more credits (rule 7). Plan 76 caps user instructions at 2000 characters.

**Default**
- Project files go under a new key prefix (`projects/<wsId>/<projectId>/…`) in an existing bucket with no expiry. The 6-bucket list stays.
- The turn puts them into `/workspace/inbox` read-only (0444) under the existing limits.
- Text context and instructions are refused when they look like a secret (`looksLikeSecret`), with caps (for example 4000 and 8000 characters).
- They are injected as a data section after the platform rules, worded like `clientInstructionsSection`: they cannot widen permissions.
- Order of the layers: platform rules, then user instructions (plan 76), then project instructions, then project context, then memory.

### B. GitHub link (public repository)

**Rules touched:** 1, 5.

**What plan 83 changed:** the sandbox can already reach a public repo.

**Conflicts**
- There is no rule conflict for a public read: no credentials, public data.
- It does not work in practice: the clone is lost every turn (§0), and a big repo hits the tmpfs limit.

**Default**
- A GitHub link is a read-only repository connection.
- `core` (trusted side) fetches it into a mirror and hands the turn a bundle, as before plan 83 (spec `:664`: *«git bundle … через stdin exec — git-провайдер из песочницы недоступен»*).
- The agent sees `/workspace/repo`.

### C. Linking a GitLab (or private GitHub) account with OAuth

**Rules touched:** 1, 2, 4, 8.

**Conflicts**
1. **Rule 1:** *«Никаких других зарубежных API с данными клиентов»* (`CLAUDE.md:252`). gitlab.com and github.com are US services.
   - Spec open question `:2362`: *«Сайты в GitHub или GitLab клиента: это зарубежные сервисы, и коммиты с контентом сайта уходят туда по выбору клиента»*.
   - Self-managed GitLab hosted in Russia has no cross-border problem.
   - **Needs an explicit owner decision:** this changes a non-negotiable rule and there is no default. The closest precedent is the 26.10.2026 open-internet exception, where what goes out by the client's choice leaves the platform.
2. **Rule 2:** tokens belong in Vault only, never in better-auth `accounts` (Yandex precedent).
   - GitLab OAuth access tokens expire after 2 h and need a refresh token.
   - Scopes are user-wide: `api`, `write_repository`, … There is no per-project scope ([GitLab OAuth](https://docs.gitlab.com/integration/oauth_provider/)).
   - `api` can delete projects and edit CI variables, so rule 4 applies to every call.
3. **Two GitLab credentials, not one.**
   - The GitLab MCP server (GA since 19.5, endpoint `/api/v4/mcp`, Free tier) accepts DCR OAuth tokens with the `mcp` scope ([GitLab MCP server](https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/)).
   - That fits plan 81's OAuth relay as-is, but an `mcp`-scoped token cannot do `git push`.
   - Git over HTTP needs a separate OAuth application with `write_repository`.
4. **GitHub needs a GitHub App.**
   - Installation tokens last 1 h, are limited to chosen repositories and to listed permissions ([GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
   - The owner has to register the App (an action, no default).
   - GitHub's remote MCP server (`api.githubcopilot.com/mcp/`) takes a PAT header. OAuth there seems to need a host-registered app; DCR support was not confirmed.
5. **Self-managed GitLab means an arbitrary instance URL.** That is an SSRF risk (plan 81 §5): reuse the public-address check and `SANDBOX_EGRESS_REFUSED_SUBNETS`. Instances on a private network cannot be reached.
6. **Rule 8:** a «GitLab connection» must not become `if (provider === 'gitlab')`.

**Default**
- Restore a `GitProvider` port with `gitlab` and `github` adapters in a `git-providers` package. The orphan interface in `ports/git-provider.ts` is a starting point.
- Connection tokens live in Vault at `kv/workspaces/<ws>/git/<connectionId>`.
  - web writes them after the OAuth callback and never reads them back.
  - `core` reads them.
  - One renewer with an advisory lock and CAS, as in plan 81.
- Not stored in `accounts`.
- gitlab.com uses an OAuth app the owner registers. A self-managed instance takes either an OAuth app id and secret entered by the client, or a project or personal access token.

### D. Cloning the repository into the sandbox

**Rules touched:** 5, 1, 2.

**What plan 83 changed:** it removed the mirror, the bundle, the patch and untracked parts of the snapshot, and git in `core` (§0).

**Conflicts**
- **Rule 5:** *«Учётных данных git … в песочнице нет»* (spec `:596`, `:604`) and *«коммит и push делает доверенная сторона»* (rule 5). A token inside the sandbox, whether a variable or `.git/config`, breaks both.
- **Size:** a full bundle is limited to 64 MiB (rule 5).
- **Rule 2 and rule 1, inbound:** a repo may contain committed secrets (`.env`). When the agent reads them, they go to Z.ai.

**Default**
- Bring back the pre-plan-83 trusted path:
  - `core` keeps a mirror (back in the core image, `GIT_MIRROR_DIR`, on the server in Russia);
  - each turn gets a shallow (depth 1) bundle, capped at 64 MiB, with a clear refusal above that;
  - capture returns the patch and untracked files as untrusted data.
- The connection token never enters the sandbox.
- Run gitleaks on fetch and show findings to the client as a warning; do not block.
- For workspace variables, see question 6.

### E. The agent committing and pushing

**Rules touched:** 5, 2, 3.

**Conflicts**
- Only a trusted side may push, after the checks: clean clone, `git apply --cached`, `fsckObjects`, gitleaks, CI-path policy (spec `:664`, `:2148`).
- Rule 3's intent: nothing reaches the client's live systems on the agent's word alone.
- Pushing every turn to the client's repo creates noise. The earlier design kept work-in-progress branches internal: *«WIP-ветки не шумят у клиента в GitHub и GitLab»* (`docs/research/2026-09-bootstrap/sandbox-critique.md:56`; spec `:628`). That internal store was Gitea, now deleted.

**Default**
- Each turn's commit goes into `core`'s mirror (`refs/raditi/<chatId>`) plus an encrypted patch in the `raditi-sessions` snapshot.
- Push to the client's repo happens only to a branch `raditi/<chatId>`, and only when an MR is created (see F).
- Pushing to the default or a protected branch is refused in trusted code.
- WIP pushes carry `-o ci.skip` on GitLab (branch pipelines only, not MR pipelines — [GitLab push options](https://docs.gitlab.com/topics/git/commit/#push-options)) and `[skip ci]` or the `skip-checks: true` trailer on GitHub (push and pull_request events only — [GitHub changelog](https://github.blog/changelog/2021-02-08-GitHub-actions-skip-pull-request-and-push-workflows-with-skip-ci)).

### F. Opening and merging MRs

**Rules touched:** 4 (main), 3, 8.

**Conflicts**
1. **Merging deploys to production** through the client's CI, so it is a dangerous action.
   - `request_approval` does not exist.
   - `confirmedByClient` is the model's claim, and *«текст модели разрешением не считается»*.
2. **Plan 81's relay passes every tool** of a skill. With GitLab MCP as a skill, the model could call `accept_merge_request` or `save_pipeline` (run, retry, cancel) directly ([GitLab MCP tools](https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server_tools/)). That contradicts rule 4.

**Default**
- Opening an MR is an agent tool in a platform `repo_*` MCP family. `mcp` reserves it and `core` applies it at the end of the pass, the same pattern as `PageChanges`.
- Merging happens only from a trusted card in the chat or the project, built like `release.prepare/confirm`:
  - an HMAC token bound to the user, MR iid, target branch and head SHA;
  - the provider merge call passes the expected head SHA (the old port signature `mergePullRequest(…, expectedHeadSha)`).
- The agent never merges.
- If GitLab MCP is also offered as a workspace skill, the relay gets a denylist: merge, pipeline run, retry and cancel, variables, settings, delete. Allowing that tool filter is an owner decision.

### G. The agent setting up CI files (`.gitlab-ci.yml`, `.github/workflows`)

**Rules touched:** 6 (marked history, but its intent still stands), 4, 2.

**The precise conflict.** The old reason for the rule was that a workflow file in the repo runs with the deploy secrets (spec `:2147`). That is still true in the client's repo, and the risk comes **at push time, before any review**:
- Pushing a branch with a changed `.gitlab-ci.yml` starts a branch pipeline. That pipeline sees every unprotected GitLab CI variable. Protected variables go only to protected branches and tags ([GitLab CI variables](https://docs.gitlab.com/ci/variables/)).
- `ci.skip` does not stop merge request pipelines.
- On GitHub, a pushed workflow runs on `push`. I believe it sees repository secrets for same-repo branches (from GitHub docs as I recall them; not fetched in this pass).

So «a visible diff and approval at merge» comes too late. A prompt injection, for example from a README, could exfiltrate the CI variables by pushing a CI change.

**Default**
- Trusted code refuses any push whose diff touches CI paths. Revive the unused `isForbiddenPath`.
- The exception is a separate trusted card «Изменить настройки CI», bound to the hash of the CI diff, which the client confirms before the push.
- The GitHub App is created **without** the `workflows` permission, so GitHub itself rejects workflow edits ([GitHub changelog 2020-04-07](https://github.blog/changelog/2020-04-07-github-apps-workflow-permission)). The platform asks for that permission only when the client turns on «Агент может менять CI».
- The owner's words («настройку CI») decide that the agent may change CI. The gating above is a default.
- **Rules 3 and 6 must be rewritten.** That is an owner sign-off, because they are non-negotiable.

### H. Viewing pipelines

**Rules touched:** 10, 1, 2.

**Conflicts**
- Rule 10 allows only one exception for raw English text: thoughts. CI statuses and job logs are English jargon.
- Logs may contain secrets that CI did not mask. Logs copied into the platform must be stored in Russia (`raditi-logs`).

**Default**
- `core` reads pipeline state with the connection token: polling, or webhooks with `X-Gitlab-Token`. The old port's `parseWebhook` already did the timing-safe signature check.
- Statuses are shown in Russian («Сборка идёт / прошла / упала»).
- Job logs are fetched when the client opens them, not stored, and shown collapsed and raw. Showing them raw is a new rule-10 exception, so the owner decides.
- The agent's own log reads go through a tool, with workspace variable values masked. They are charged inside the pass (rule 7). Viewing in the web costs nothing.

### I. «Катить проект» = deploying through the client's CI

**Rules touched:** 3, 4.

**The precise conflict.** Rule 3 used to guarantee backup, verification, automatic rollback, «Отменить выпуск» for 7 days, and `main` equal to the installed version. None of that can be promised when the client's CI deploys. This is open question spec `:2352`: *«как сохранить бэкап, проверку и автооткат?»*.

**Default**
- The platform does not deploy by itself. «Выкатить» means one of:
  - merge (F);
  - run a manual deploy job (`when: manual`) through the same trusted card.
- `core` then follows the pipeline. The existing statuses `deploying` and `verifying` can be reused.
- The text promises no rollback, as Б1/Б24 already do: «Развёртывание делает ваш конвейер; Радити может открыть запрос на отмену (revert)». A revert is a new MR through the same card.
- **Owner decides:** whether tags and manual jobs are allowed, not only merges.

### J. Project memory stored and sent to the model

**Rules touched:** 1, 2, 4, 7, 8, 10.

**Conflicts and facts**
- **Rule 8 and how OpenCode runs here:**
  - OpenCode runs with `OPENCODE_DISABLE_PROJECT_CONFIG=1` (`packages/agent-drivers/src/opencode.ts:110`) and does not read the repo's `AGENTS.md`. Instructions must come through `RunContext.instructions` (spec `:846`).
  - Only two database files from `/agent-home` survive into the snapshot (spec `:1188`), so memory files written in the sandbox are lost.
  - Memory must therefore be stored by the platform and injected without depending on the driver. No `if (driver === 'opencode')`.
- **Rule 1:** store it in PostgreSQL in Russia. It goes to Z.ai every pass under the gate.
- **Rule 2:** refuse secret-like entries. `core` checks variable values and turn keys at the end of the pass, as Ст19 does for pages.
- **Memory poisoning (rule 4's intent):** text from a web page or a repo file can be written into memory and persist across sessions.
- **Rule 7:** a separate pass that extracts memory costs tokens, and it is unclear who pays.
- **Rule 10:** the client reads the entries, so they must be in Russian.
- **«Использовать память аккаунта»:** memory from one workspace could leak into another workspace's chats, which other members see.

**Default**
- The agent writes memory with `memory_*` tools during an ordinary pass. They are reserved, and `core` applies them at the end of the pass. No hidden LLM calls, so billing stays as it is.
- Memory is a data section that cannot widen permissions.
- The client sees, edits and deletes each entry.
- Passes without supervision may read memory but not write it.
- Entries are written in Russian.
- Account memory applies only within the same workspace.

### K. Scheduled tasks running unattended on a project

**Rules touched:** 4, 7, 1, 2, 5.

**Facts that block merging plan 82 as built**
- `[sched] packages/db/prisma/schema.prisma:3355`: `ScheduledTask.siteId`.
- The migration `[sched] …/20261116120000_scheduled_tasks/migration.sql:108,184` has a foreign key to `"sites"`, which plan 83's `20261116110000_remove_projects` drops. It also shares its timestamp with plan 83's `20261116120000_credential_kind_mcp_server_workspace`.
- Зп28's click refusal relies on `browserCommitAction`. In open-web mode that is now `() => null` (`packages/domain/src/browser/open-web.ts:103`), and the stack policy (`readOnlyDenied`) is gone. Only the request-level read-only check and the instructions remain.

**Conflicts**
- Without supervision nobody can confirm anything.
- Зп32 already refuses `confirmedByClient` tools and page changes (`[sched] docs/plan/82-scheduled-tasks.md:94`). The same must apply to merge, CI changes and pushes to the client's repo, because a push starts pipelines.
- The GitLab token may expire with nobody present to sign in again.

**Default**
- Unattended passes may fetch the repo and change code in the mirror. They prepare an MR proposal that waits for the client's card.
- They never push to the client's repo or merge.
- Credits: one new chat per run and per-pass charging, as in plan 82 (Зп17, `:69`).
- If token refresh fails, the run is refused with the reason «нужно войти в GitLab заново» and the task pauses.
- Push notification payloads stay IDs only (Зп40).
- Rebind `scheduled_tasks.site_id` to the new projects table in a fresh migration.

### L. Rules 9 and 10, cross-cutting

- **Rule 9:** nothing new unless project-level costs are shown. Keep the `averageTaskCredits` style of hint.
- **Rule 10:** «merge request», «pipeline», «CI/CD», «коммит», «ветка» are jargon for small-business clients.
  - Default: Russian words, with the technical term once in brackets, only inside the Git section.
  - Whether the audience of projects is developers is an owner question.

## Implications for Raditi projects

1. **Projects with a repository reverse part of plan 83.**
   - Bring back: git and gitleaks in the `core` image, a mirror, bundles into turns, the patch and untracked parts of the snapshot, a repository plan in `turnPlanSchema`, and a `GitProvider` port with adapters.
   - Do not bring back: Gitea, previews, `/release`, CMS adapters.
   - Plan 84 should say this openly and treat it as rebuilding the trusted git side, not as a new design.
2. **The new safety line is «push and merge by trusted code, confirmed by a trusted card».**
   - It replaces «outputs only via `/release`».
   - CI edits are gated at push time, not merge time.
   - On GitHub, the App's withheld `workflows` permission adds a second, provider-enforced line.
3. **Plan 81's OAuth relay fits a GitLab MCP skill out of the box (DCR, `mcp` scope), but it is not enough.** Git push needs a separate OAuth app and token, and the relay needs a tool denylist before GitLab MCP can be offered safely.
4. **Workspace variables (БП4) are already a path for long-lived git credentials into the sandbox.** The project's Git section is pointless as a safety boundary unless this is closed or explicitly accepted.
5. **Plan 82 cannot be merged as-is.**
   - It depends on the deleted `sites` table.
   - Its migration shares a timestamp with a plan 83 migration.
   - Its stack-based read-only browser check no longer works.
   - It must be rebound to the new `projects` entity, with unattended git rules (K) added.
6. **Documents to update.**
   - Rules 3, 5, 6 and 8 and the «Расхождения» entry need rewriting.
   - The rail already links «Проекты» to `/projects` with no route (`apps/web/src/components/application/application-rail.tsx:19`). The new page fills that hole.
   - The name «проект» now means something new. Old texts such as «Проект удалён» in plan 82 and the history paragraphs must not be confused with it.
7. **Storage.** Project files need a non-expiring key prefix inside an existing bucket. The 90-day `raditi-inbox` lifecycle and the six-bucket rule both stand in the way of the obvious choice.

## Questions for the owner (each with a proposed default)

1. **May client code and content go to foreign github.com and gitlab.com (an exception to rule 1, open question spec `:2362`)?** No default: this is a rule change. Proposed: yes, as the client's own chosen destination; self-managed GitLab in Russia always allowed.
2. **Rewrite rules 3 and 6 for client repositories.** Proposed: the agent never pushes to default or protected branches, never merges, and never changes CI without a trusted card; the platform promises no rollback; a revert is a new MR. Needs sign-off because the rules are non-negotiable.
3. **May the agent change CI files at all?** Default: yes (your words), but only after a separate trusted card bound to the CI diff hash. Withheld until then: the GitHub `workflows` permission, and pushes of CI paths to GitLab.
4. **What does «выкатить» mean?** Default: merge to the default branch through the trusted card, or run a `when: manual` deploy job. No tags. The platform only follows the pipeline.
5. **Where do work-in-progress commits live?** Default: in `core`'s mirror and the encrypted snapshot. Push to the client's repo (`raditi/<chatId>`, with `ci.skip` / `[skip ci]`) only when an MR is created.
6. **A GitLab or GitHub token placed in «Переменные» bypasses all of this (БП4).** Default: keep БП4 as you decided, warn on known token shapes (`glpat-`, `ghp_`, `github_pat_`), and never use variables for Git. The alternative is to refuse those shapes.
7. **Connection credentials.**
   - No default for the action: you need to register a GitLab.com OAuth application (scopes `api`/`write_repository`) and a GitHub App (contents, pull requests, checks; no `workflows`).
   - Default for self-managed GitLab: the client enters a project or personal access token.
8. **GitLab or GitHub MCP as a workspace skill (plan 81 relay).** Default: allowed only with a relay denylist: merge, pipeline run, retry and cancel, variables, settings, delete. Write actions go through Raditi's own `repo_*` tools.
9. **CI job logs in raw English (an exception to rule 10).** Default: statuses in Russian; logs raw, collapsed, fetched on view, not stored.
10. **Repository size.** Default: a shallow bundle capped at 64 MiB, with a clear refusal above that.
11. **Secrets found in a fetched repo.** Default: warn the client with the file list, do not block, mask what can be masked.
12. **Memory.** Default:
    - written only through agent tools during ordinary passes;
    - in Russian;
    - each entry visible and editable;
    - unattended passes read only;
    - «память аккаунта» only within the same workspace;
    - no separate hidden extraction pass. If you want nightly consolidation, its credits need a decision.
13. **Scheduled tasks on a project with Git.** Default: unattended runs prepare an MR proposal and never push or merge; a failed token refresh pauses the task.
14. **Audience wording.** Default: client-facing Russian («запрос на слияние», «сборка»), with the technical term once in brackets inside the Git section.
15. **Project files storage.** Default: a new key prefix `projects/<wsId>/<projectId>/` in an existing bucket with no lifecycle; no seventh bucket.

## Sources

- GitLab OAuth provider: https://docs.gitlab.com/integration/oauth_provider/
- GitLab MCP server: https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/
- GitLab MCP tools: https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server_tools/
- GitLab push options (`ci.skip`): https://docs.gitlab.com/topics/git/commit/#push-options
- GitLab CI/CD variables (protected variables): https://docs.gitlab.com/ci/variables/
- GitHub App installation tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- GitHub Apps `workflows` permission: https://github.blog/changelog/2020-04-07-github-apps-workflow-permission
- GitHub `[skip ci]`: https://github.blog/changelog/2021-02-08-GitHub-actions-skip-pull-request-and-push-workflows-with-skip-ci and https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs
- GitHub MCP server setup: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server

No repository files were changed.