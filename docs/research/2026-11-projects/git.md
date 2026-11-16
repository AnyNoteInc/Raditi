# Connecting a client's GitHub and GitLab to Raditi projects: research report

I edited no files. Code references point at `origin/main` (read with `git show`) or at the `raditi-noprojects` worktree (`raditi-noprojects`, branch `feat/remove-projects`).

## 0. What Raditi already has

**The port survived plan 83.** `packages/domain/src/ports/git-provider.ts` is still in raditi-noprojects (188 lines), identical to main.
- Header (line 3): "Git credentials never enter the sandbox: the platform publishes from a clean clone."
- `GitProvider` (lines 123–188) has these methods: `getRepository`, `issueCredentials(ref, 'read'|'write', ttlSeconds)`, `openPullRequest`, `getPullRequest`, `mergePullRequest(ref, n, expectedHeadSha)`, `closePullRequest`, `set/deleteActionsSecret`, `setActionsVariable`, `protectTags`, `createTag`, `getTag`, `listWorkflowRuns`, `getWorkflowRun`, `dispatchWorkflow`, `parseWebhook`.
- Normalized events (lines 114–121): `pull_request | workflow_run | workflow_job | push | tag`.

**On main the adapters are stubs, but webhook checks are real.**
- `packages/git-providers/src/github.ts:6` says "TODO(P8): API client, likely a GitHub App"; `gitlab.ts:6` says "TODO(P8): REST API client".
- Every API method throws `NOT_IMPLEMENTED` (`stub-provider.ts:8-60`).
- Webhook signature checks work: `webhook-signature.ts:19-35` verifies `X-Hub-Signature-256` as an HMAC and compares `X-Gitlab-Token` in a timing-safe way.
- Plan 83 deleted the `git-providers` package, `core/git-workspace` and `git`/`gitleaks` from the core image (`docs/plan/83-remove-projects.md:28,43,45,64,65`).

**The trusted git code is recoverable from main.** `apps/core/src/git-workspace/trusted-git.ts`:
- `:38` — `GIT_CREDENTIAL_TTL_SECONDS = 120` ("one grant: a clone, a ls-remote or a push").
- `:44-60` — the environment inherits nothing but PATH; global and system git config is off.
- `:66-112` — options include `credential.helper=` (empty), `http.followRedirects=false`, `transfer.fsckObjects=true` and `--config-env=http.extraHeader=RADITI_GIT_AUTH`. The token travels only in the environment, never in argv or a URL.
- Spec §10 on main: the turn base arrives in the sandbox as a bundle, and the trusted side publishes the patch through clean clone → DiffPolicy → gitleaks → bot commit → push. On client GitHub/GitLab it says: "Ветки и PR — через `GitProvider`… Выкладку там делает пайплайн клиента… открытый вопрос".

**Sandbox network.**
- `infra/sandbox/gateway.mjs:58` — "No dynamic target selection, redirects, CONNECT, upgrades". Routes are static: `:20` LLM paths, `:37` `skillRelayPath`, `:76-92`.
- The sandbox also has open internet through `client-egress.mjs`: `ALLOW_PUBLIC` at `:37-43`, `OPEN_TLS_PORTS = 443, 8443` at `:96`.
- So any token placed in the sandbox can be exfiltrated, while public repositories can be cloned anonymously.

**Precedents to reuse.**
- Plan 81 (main, `docs/plan/81-mcp-server-credentials.md` §3.1–3.2): a relay in `apps/mcp` injects a secret from Vault and the sandbox never sees it. It rejects a TLS-intercepting CA in the sandbox ("подменял бы любой TLS").
- Plan 73: page tools are applied by core at the end of the turn (`apps/core/src/tasks/page-changes.ts:53`, `packages/domain/src/pages/feed.ts:69`).
- Page deletion relies on the agent's own `confirmedByClient: true` (`apps/mcp/src/pages/pages-arguments.ts:114`). No real `request_approval` exists.

**Constraints already in place.**
- `.dependency-cruiser.cjs:392-401` (`mcp-minimal-packages`) — `apps/mcp` must carry "no git".
- Web has no git webhook route; only `apps/web/src/app/api/webhooks/{telegram,yookassa}`.
- In the noprojects `CLAUDE.md`, rules 3 and 6 are marked "история" (`:254`, `:257`). Git-backed projects need them restated.

**A zero-integration path already exists.** Plan 83 БП4 (`83-remove-projects.md:30`) gives every workspace variable to every turn's `bash` through `BASH_ENV`. A client can paste a GitHub PAT today, which puts a long-lived token in the sandbox.

## 1. GitHub

### 1.1 Credential options

| Option | Lifetime | Scope | Notes |
|---|---|---|---|
| **GitHub App installation token** | 1 h, fixed | Repos the client picked at install; can be narrowed per token with `repositories`/`repository_ids` (up to 500) and a subset of `permissions` | Acts as `app[bot]`. Git over HTTPS uses user `x-access-token`. Revoke early with `DELETE /installation/token` → 204. [docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [create token](https://docs.github.com/en/rest/apps/apps), [revoke](https://docs.github.com/en/rest/apps/installations) |
| **GitHub App user access token** (user-to-server) | 8 h (28800 s); refresh token 6 months (15811200 s), rotated on every refresh | Intersection of user and app access | Needed to verify an installation belongs to the user. [refreshing](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens) |
| OAuth App | Long-lived by default (8 h optional) | "access to all of the user's… accessible resources" | `repo` = full code access; `workflow` = "add and update GitHub Actions workflow files". GitHub: "GitHub Apps are preferred over OAuth apps"; OAuth apps have lower rate limits. [differences](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps), [scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) |
| Fine-grained PAT | Org can cap it (default policy 366 days) | Chosen repos and permissions | Org owners can require approval for each token. [policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization) |

Two facts matter for onboarding:
- **The setup URL can be spoofed.** The `installation_id` sent to the app's Setup URL can be forged, so confirm it with a user token of the person who installed the app ([about the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)).
- **Org installs need the owner.** On an organization repo only an org owner completes the install; otherwise GitHub sends the owner a request ([Claude projects doc](https://code.claude.com/docs/en/claude-projects)).

### 1.2 Permissions needed to ship

Source: [permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

| Permission | Level | What it covers |
|---|---|---|
| Contents | read/write | Clone, push, refs, **and merging**: the merge endpoints sit under Contents, not Pull requests |
| Pull requests | write | Create and edit PRs, reviews, comments |
| **Workflows** | write | Required in addition to Contents for any write under `.github/workflows` |
| Actions | read / write | Read: runs, jobs, logs. Write: rerun, cancel, dispatch |
| Checks / Commit statuses | read | Third-party CI results |
| Deployments / Environments | read | Deployment state |
| Administration | write | Branch protection and rulesets; Raditi should not request it |

**The Workflows permission is enforced by GitHub itself.** Pushes touching workflow files fail with "refusing to allow a GitHub App to create or update workflow … without `workflows` permission". The `actions` permission does not cover them ([community thread](https://github.community/t/refusing-to-allow-a-github-app-to-create-or-update-workflow-without-workflows-permission/182573)).

So an installation token minted without `workflows` blocks CI edits at GitHub's side. Requesting `workflows` at app registration lets Raditi add it to a token later, after the client approves. Adding a permission afterwards makes every installation re-accept.

### 1.3 API surface

**Merge.**
- `PUT /repos/{o}/{r}/pulls/{n}/merge` takes `sha` ("SHA that pull request head must match"), returns 409 on mismatch and 405 when the PR cannot merge ([pulls](https://docs.github.com/en/rest/pulls/pulls)).
- `PUT …/merge-async` (GA 2026-10-01) is now recommended over the synchronous REST merge and GraphQL. It returns 202 plus a UUID, supports merge queues and stacked PRs, and has `bypass_rules` ([changelog](https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available)).
- Auto-merge on one PR is GraphQL only (`enablePullRequestAutoMerge`) ([discussion](https://github.com/orgs/community/discussions/24719)).

**Actions.**
- Jobs list per run attempt, with steps and conclusion.
- `GET /repos/{o}/{r}/actions/jobs/{job_id}/logs` returns a 302 to a URL that "expires after 1 minute"; run logs come as an archive ([workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)).

**Rulesets.** "Restrict file paths" push rules can block `.github/workflows/**/*`. They are available on Team for private repos and on Free only for public repos. Path exceptions are in public preview since 2026-08-25 ([GA changelog](https://github.blog/changelog/2024-09-10-push-rules-are-now-generally-available-and-updates-to-custom-properties/), [about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).

**GitHub Enterprise Server.** Same API under `https://HOST/api/v3`, with 1 h installation tokens. The app must be registered on each GHES instance ([GHES 3.22 installations](https://docs.github.com/en/enterprise-server@3.22/rest/apps/installations)).

**Webhooks.** A GitHub App has one webhook URL for all its installations, signed with `X-Hub-Signature-256`. Raditi's verifier already exists.

## 2. GitLab (gitlab.com and self-managed)

### 2.1 OAuth

- **Scopes** ([OAuth provider](https://docs.gitlab.com/integration/oauth_provider/)):
  - `api` = "complete read/write access to the API, including all groups and projects".
  - `read_repository` = Git over HTTP or the Repository Files API.
  - `write_repository` = Git over HTTP "(not using the API)".
  - For a PAT, `api` also covers Git over HTTP; group and project access tokens do not get that clause ([token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)).
- **MR work needs `api`.** OAuth tokens cannot be limited to one project.
- **Lifetimes.** Access tokens last 7200 s by default (configurable on self-managed since 19.1). A refresh "invalidates the existing access token and refresh token" ([OAuth API](https://docs.gitlab.com/api/oauth2/)), so Raditi needs a single refresher with CAS.
- **PKCE.** `code_challenge` with S256 is supported. `root_namespace_id` exists for SAML SSO groups.
- **Git over HTTPS** uses `https://oauth2:<token>@host/…`.
- **Application owners** (19.3): an OAuth application can be instance-, group- or user-owned. A group Owner or any user can create one, so self-managed clients can register an app for Raditi without an admin.
- **Dynamic Client Registration** (`POST /oauth/register`) exists but is aimed at MCP clients; admins can turn it off ([GitLab MCP server](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)).

### 2.2 Other token types

- **Project access tokens:** "On GitLab.com, project access tokens require a Premium or Ultimate subscription"; on self-managed they work with any license. Lifetime is up to 365 days (400 behind a flag) ([project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)).
- **Fine-grained PATs:** GA in 19.2, scoped by resource and permission ([fine-grained tokens](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_other/)).
- **Group service accounts with PATs:** this is how Devin connects self-managed GitLab — `api` scope, Developer role ([service accounts API](https://docs.gitlab.com/api/service_accounts/), [Devin](https://docs.devin.ai/enterprise/integrations/gitlab-self-managed)).
- **Deploy tokens and deploy keys:** suitable only for pulls or for an SSH key with write; not useful for MRs. I did not re-check these against docs: [deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/).

### 2.3 API surface

- **Merge:** `PUT /projects/:id/merge_requests/:iid/merge` with `sha`, which returns 409 "SHA does not match HEAD of source branch". It also takes `auto_merge` ("merges when checks pass"; `merge_when_pipeline_succeeds` is deprecated since 17.11), `squash` and `should_remove_source_branch` ([MR API](https://docs.gitlab.com/api/merge_requests/)).
- **Pipelines and jobs:** `GET /projects/:id/pipelines/:pid/jobs` and `GET /projects/:id/jobs/:job_id/trace` (the log) ([jobs API](https://docs.gitlab.com/api/jobs/)).
- **CI lint:** `POST /projects/:id/ci/lint` with `content`, `dry_run`, `include_jobs` and `ref` returns `valid`, `errors`, `merged_yaml` and `jobs` ([lint API](https://docs.gitlab.com/api/lint/)). Use it to validate `.gitlab-ci.yml` before committing.
- **Environments:** list and stop ([environments API](https://docs.gitlab.com/api/environments/)).
- **Webhooks:** pipeline, job, MR and deployment events. The `X-Gitlab-Token` secret is static. An HMAC `webhook-signature` (Standard Webhooks, `whsec_…`) is GA since 19.1 ([webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)). Creating a project hook needs Maintainer.
- **Path restriction:** push rules "Prohibited filenames" are Premium/Ultimate only ([push rules](https://docs.gitlab.com/user/project/repository/push_rules/)). No token-level path control like GitHub's `workflows` exists. Protected branches are Free, but `allowed_to_push` per user is Premium ([protected branches API](https://docs.gitlab.com/api/protected_branches/)).
- **GitLab's own MCP server:** GA in 19.5 on all tiers, with tools such as `accept_merge_request` (with a `sha` guard) and `get_pipeline` ([19.5 release](https://docs.gitlab.com/releases/19/gitlab-19-5-released/), [MCP tools](https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/)).

## 3. Russia (Raditi servers are in Russia)

**GitHub.**
- Reachable from Russia.
- In April 2022 it suspended accounts tied to US-sanctioned firms such as Sberbank and Alfa-Bank ([BleepingComputer via mirror](https://hn.jakechampion.name/reader/https://www.bleepingcomputer.com/news/security/github-suspends-accounts-of-russian-devs-at-sanctioned-companies), [Cointelegraph](https://cointelegraph.com/news/github-suspends-accounts-of-russian-developers-linked-to-sanctioned-firms)).
- The platform already depends on GitHub: its code and `ghcr.io/anynoteinc/raditi` images live there.

**GitLab.**
- Suspended new business in Russia and Belarus in March 2022 ([Habr](https://habr.com/ru/news/655455/), [AIN](https://en.ain.ua/2022/10/11/gitlab-provides-services-to-the-russian-army-contractors/)).
- Low-trust sources (vc.ru, payment and VPN vendors) report unstable gitlab.com access and rejected Russian cards ([MDS blog](https://mosdigitals.ru/blog/ispolzovanie-github-gitlab-v-usloviyah-sankczij-v-rossii)).
- Paid tiers effectively cannot be bought from Russia, so the Premium-only project access tokens and push rules on gitlab.com are out of reach. On gitlab.com that leaves OAuth acting as the user. Self-managed GitLab CE is common in Russia.

**Russian alternatives.**
- **SourceCraft** (Yandex): public REST API with a PAT as Bearer; CI in `.sourcecraft/ci.yaml`; sign-in through Yandex ID ([REST API](https://sourcecraft.dev/portal/docs/en/sourcecraft/operations/api-start), [PAT](https://sourcecraft.dev/portal/docs/en/sourcecraft/security/pat)).
- **GitFlic:** has a REST API (`Authorization: token`) but thin documentation ([Habr Q&A](https://qna.habr.com/q/1369216)).
- **GitVerse** (Sber): its API was designed to resemble GitHub's ([Habr](https://habr.com/ru/articles/968498)).

## 4. How other agent products get repo access

| Product | How access is granted | Who holds the token | How changes get out |
|---|---|---|---|
| Claude.ai projects, «Add from GitHub» | GitHub integration | Anthropic | **Read-only** file sync ("Sync now"). Content disappears when access is lost ([support](https://support.claude.com/en/articles/10167454-use-the-github-integration)) |
| Claude Code cloud | Claude GitHub App or `/web-setup` (`gh` token) | Credentials "never enter a session's VM"; the GitHub proxy "verifies and swaps" a scoped credential | Proxy rejects branch deletions and tag pushes, "doesn't limit which branches a push can update" (use rulesets). API limited to attached repos; GraphQL is blocked ([cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [environments](https://code.claude.com/docs/en/cloud-environments)). The earlier [engineering post](https://www.anthropic.com/engineering/claude-code-sandboxing) said "only pushing to the configured branch", which has since loosened. GitLab only as an uploaded bundle, with no push back. In Projects each thread works on its own branch, opens a PR and watches its CI with auto-fix ([projects](https://code.claude.com/docs/en/claude-projects)) |
| Codex cloud | GitHub connector; GitLab (Beta) | Platform | Agent phase is offline by default; "Secrets… available only during setup and are removed before the agent phase"; PR at the user's request ([security](https://learn.chatgpt.com/docs/agent-approvals-security), [cloud](https://learn.chatgpt.com/docs/cloud)) |
| Copilot coding agent | Runs in Actions | GitHub | Can push only to its own `copilot/` branch; "cannot directly run `git push`"; only users with write access can trigger it; workflows on its PRs wait for approval; firewall ([risks](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)) |
| Cursor cloud agents | GitHub App with read-write | Restricted per-run token **inside the VM** (forum reports) | Agent pushes from the VM ([security](https://cursor.com/docs/cloud-agent/security-network), [forum](https://forum.cursor.com/t/cloud-agent-gh-git-token-missing-issues-write-despite-github-app-being-granted-issues-read-write/163389)) |
| Jules | GitHub app; clones into a GCP VM | Google | Branch plus PR after the plan is approved (third-party sources only) |
| Devin | GitLab service-account PAT with `api`, or per-user OAuth | Devin; tokens encrypted | Per-org repo permissions ([Devin GitLab](https://docs.devin.ai/integrations/gitlab)) |

## 5. Patterns for a sandbox with no long-lived secrets

- **A — trusted side in and out.** The trusted side fetches and builds a bundle into the sandbox, then takes the patch or commits out, checks them and pushes. This is old Raditi, Codex's offline agent phase and Claude Code's bundle path. The sandbox never sees a credential, and one diff check covers both providers. The agent cannot `git fetch` mid-turn.
- **B — git smart-HTTP proxy on a trusted gateway.** The sandbox sends a per-turn token; the gateway swaps it for the real one, as Claude Code does. Raditi could add a static `sandbox-gw` route such as `/git/<alias>.git/{info/refs,git-upload-pack,git-receive-pack}` to a trusted role.
  - On receive-pack it parses the pkt-line ref commands and allows only `refs/heads/raditi/…`, with no tags and no deletes.
  - Inspecting pack contents for CI paths is costly, so path rules rely on GitHub's `workflows` permission or rulesets.
- **C — short-lived token inside the sandbox** (Cursor-like). A GitHub installation token scoped to one repo, minimal permissions and 1 h, revoked at turn end. With Raditi's open egress, the sandbox can use it anywhere for up to an hour. It is unusable for GitLab OAuth, whose token is 2 h and reaches every project of the user.
- **Native backstops.**
  - GitHub: a token without `workflows`; rulesets; branch protection; the merge `sha` guard.
  - GitLab: protected branches (Free); push rules (Premium); the merge `sha` guard.

## Implications for Raditi projects

1. **Port (rule 8).** Restore `packages/git-providers` from main and write real `github` and `gitlab` adapters.
   - Keep the methods that apply: `getRepository`, `issueCredentials`, PR methods, `mergePullRequest(expectedHeadSha)`, `listWorkflowRuns`, `getWorkflowRun`, `dispatchWorkflow`, `parseWebhook`.
   - Drop or park the Gitea release methods (`protectTags`, `createTag`, scoped workflows).
   - Add `listRepositories(connection)`, `listJobs(run)`, `getJobLog(job, {tailBytes})`, `rerunRun`/`cancelRun`, `getChecks(ref, sha)` (Actions plus check runs or pipelines), `setAutoMerge`, `lintCi` and `listDeployments`.
   - Add a `support` object, like `SiteAdapter.support` (for example `ciLint: true` only on GitLab), so callers branch on capabilities, never on `kind`.
2. **Data model.**
   - `git_connections` at workspace level, next to `/settings/variables`: provider kind, host base URL, GitHub `installation_id` or GitLab user id, `credential_refs`.
   - `project_repositories`: project → connection, repo id and path, default branch, branch prefix `raditi/`.
   - «Контекст → GitHub-ссылка» for a public repo can be a read-only snapshot fetched by core with no connection, like Claude.ai's «Add from GitHub». A private repo requires a connection.
3. **Secrets (rule 2).**
   - GitHub App private key and webhook secret → Vault `kv/platform/github-app`. Installation tokens are minted per operation (one `repository_ids`, minimal `permissions`) and never stored.
   - GitLab OAuth client secret: for gitlab.com → `kv/platform/gitlab-oauth`; for a client's own instance → `kv/workspaces/<ws>/git/<conn>/oauth-client`.
   - GitLab user tokens `{access_token, refresh_token}` → KV v2 with `max_versions=1` and CAS, refreshed by one writer, as in the P3 B10 pattern and plan 81 OAuth.
4. **Which process holds them.** For the MVP, core: it ran trusted git before, but needs `git` and `gitleaks` back in its image.
   - `apps/mcp` stays without provider credentials (`mcp-minimal-packages`).
   - If pattern B arrives later, a dedicated `apps/git` role mirroring `apps/llm` ("the one process that holds a provider key").
5. **Turn access for the MVP (pattern A).**
   - At preparation, core fetches into its mirror with a fresh token and bundles the working tree plus shallow history. Size limit to be decided; Claude Code uses 100 MB.
   - At turn end, core takes the agent's commits or patch and runs DiffPolicy: CI paths and `.gitmodules` only with a per-chat grant; gitleaks; workspace variable values.
   - Then it commits as the bot and pushes to `raditi/<chat>` with an expected old SHA, using `contents:write`, plus `workflows:write` only when granted.
   - Pattern B (live fetch through a `sandbox-gw` route) is phase 2.
6. **Agent tools.** Add `raditi_git_*` tools in `apps/mcp`.
   - Reads come from state core syncs into PostgreSQL and S3: PR or MR state, runs and pipelines, job-log tails.
   - Writes follow the plan 73 pattern (`PageChanges`): recorded as pending and applied by core at turn end. Examples: open PR/MR, comment, rerun.
   - **Merge** and **deploy** (`workflow_dispatch`, running a pipeline or playing a manual job) need a client approval card in the feed bound to the head SHA. Core executes it on click: GitHub merge with `sha` or async merge; GitLab with `sha`, optionally `auto_merge`. This is stronger than the agent's own `confirmedByClient`.
7. **CI edits — restated rule 6.** The agent may change CI configuration only after the client approves it in that chat.
   - GitHub enforces this natively: the token lacks `workflows` until approval.
   - GitLab relies on core's DiffPolicy before push; push rules are not available on Free.
   - Validate with GitLab's CI Lint `dry_run`; for GitHub, `actionlint` in the sandbox image.
8. **Pipelines UI.**
   - GitHub App webhook to a new public `POST /api/webhooks/github`.
   - GitLab project hook created by core via the API (HMAC signing token) to `/api/webhooks/gitlab`, only when the connecting user is Maintainer.
   - Otherwise poll every 30–60 s while a run is active; `listWorkflowRuns` already exists as the fallback.
   - Web stores the raw event and an outbox row; core normalizes it with `parseWebhook`.
   - Outbound calls to self-managed hosts need the SSRF checks of plan 81 §3.2 p.4 (`isPrivateAddress`, DNS pinning).
9. **Logs (rule 1).** Core fetches a failed job's log: GitHub's 1-minute redirect is followed only to GitHub-owned hosts.
   - Keep the last 64 KiB or less, strip ANSI and mask variable values, then store in `raditi-artifacts` (Russia).
   - Show them in a «CI/CD» tab; the agent reads them for auto-fix.
   - Repo contents and logs reach GLM like any chat file, under the 152-ФЗ gate.
10. **MVP.**
    - In: GitHub App on github.com plus GitLab OAuth on gitlab.com and self-managed (client creates a user- or group-owned OAuth app). One repo per project, branch push, PR/MR on request, runs/pipelines with job-log tails, merge and CI edits on approval.
    - Later: GHES; a live git proxy; auto-fix that watches PR CI and starts a turn (fits plan 82 triggers); a deployments and environments view; a GitLab PAT or service-account option; a Russian host adapter; "act as me" user tokens on GitHub.

## Questions for the owner (each with a proposed default)

1. **Whose name is on commits and merges?** *Default:* GitHub as the bot `raditi[bot]` (installation token). GitLab will necessarily be the connecting user (OAuth), unless the client gives a project access token.
2. **When does the agent push?** *Default:* automatically after each turn with changes, to `raditi/<chat>`. A PR or MR is opened only when the client asks or accepts the agent's proposal.
3. **Merge rules.** *Default:* always a client button in the chat, bound to the head SHA, with an option «слить, когда проверки пройдут» (auto-merge).
4. **CI configuration edits.** *Default:* allowed only after per-chat approval; rule 6 is restated this way.
5. **Deploy actions** (workflow_dispatch, manual job, pipeline on main). *Default:* same approval card as merge.
6. **Hosts in the MVP.** *Default:* github.com, gitlab.com and self-managed GitLab reachable from the server. GHES, private-network GitLab and the Russian hosts (GitFlic, SourceCraft, GitVerse) come later. Which Russian host matters first to your clients?
7. **Repository size limit.** *Default:* 100 MiB bundle; above that, a refusal with a plain-text explanation.
8. **GitHub App owner and sanctions risk.** *Default:* register the app under the existing org (`anynoteinc`) and accept the same risk as the platform's code and images.
9. **Fallbacks for clients who cannot install the app.** *Default:* GitLab PAT or project access token — yes; GitHub PAT — no in the MVP.
10. **Public webhook endpoints.** *Default:* `/api/webhooks/github` and `/api/webhooks/gitlab` on raditi.ru, with polling as fallback.
11. **Repos and CI logs going to GLM.** *Default:* treated like chat files; in `client` workspaces only after the 152-ФЗ gate.
12. **Cleanup after merge.** *Default:* delete the `raditi/…` branch.
13. **Billing for auto-fix CI loops.** *Default:* charged per pass like any turn, and only when the client turned auto-fix on.