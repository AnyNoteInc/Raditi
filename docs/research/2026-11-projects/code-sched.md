# Plan 82 (scheduled tasks) and new projects: what's built, where it depends on sites, the conflict with plan 83, and how to rebind

Worktree `raditi-sched`, branch `feat/scheduled-tasks`. Its HEAD is `84c22b74`, a merge of `origin/main`; its base with main is `93b47a51`. The branch is **not pushed** and has no PR. Plan 83 (`origin/feat/remove-projects`, PR #104, open) has the same base `93b47a51`. Refs marked (wt) are to the uncommitted working tree.

**Work in progress.** The sched worktree has **114 uncommitted paths**, last modified 18:22–18:30 today. This is the review 82.9, and another session is probably working there now. `docs/plan/82-scheduled-tasks.md` at HEAD still says «82.6 — срез в работе» and «82.7 — срез в работе». Yet both are committed: `f2018b6d` (push) and `f5e04f43` (the section), plus `0ff0494b` (chat setup).

## 1. What plan 82 built

**Decisions.** Зп1–Зп43 (plan 82 §3), recorded as spec §20 «Запланированные задачи — решения 15.11.2026». The groups:
- **Section and window (Зп1–Зп10).**
  - The rail item «Задачи» goes between «Чаты» and «Страницы»; the link's `aria-label` is «Запланированные задачи» (`apps/web/src/components/application/application-rail.tsx:24-32`).
  - Pages: `/scheduled` («Ваши»), `/scheduled/templates`, `/scheduled/<id>`.
  - The empty state has a stopwatch, «Запланированных задач пока нет.» and six templates.
  - The window «Новая запланированная задача» has «Название», «Что сделать агенту», a **ProjectPicker in place of Claude's «Авто»**, «Размышление» (EffortMenu) **in place of «Модель по умолчанию»**, «Когда запускать» with up to 5 schedules («+ Добавить время»), «Следующий запуск…», a cost line, «Уведомлять, когда задача выполнится» with push control, and «Дополнительные настройки» holding **only the time zone**.
  - Code: `apps/web/src/components/scheduled/schedule-dialog.tsx:38-39, 476-491, 574, 598, 657`; texts in `schedule-texts.ts:121-146`.
- **Schedule (Зп11–Зп16).**
  - Kinds: once, hourly, daily, weekdays, weekly, monthly, manual-only. No cron or RRULE.
  - Not more often than once an hour. Time zone is IANA, stored per task, with `users.timezone`.
  - Catch-up: one run for the last missed time, no older than 6 h.
  - At most 20 enabled tasks per workspace.
- **Runs (Зп17–Зп26).**
  - Each run is a new chat made through the same `createDialog`.
  - Preview is built on demand (`preview: 'on_demand'`, Зп18).
  - `core` ticks every 60 s (`schedule.tick` on the `schedules` queue) and claims tasks with `FOR UPDATE SKIP LOCKED`. It writes an outbox `schedule.start`, which POSTs `{runId}` to web at `SCHEDULE_INTAKE_URL` (`/api/webhooks/scheduled-runs`) with secret `SCHEDULE_INTAKE_SECRET`.
  - The run's chat id is a deterministic UUID v7.
  - Rights: the creator must still be owner or admin of the workspace (Зп25).
  - Three client refusals in a row pause the task (`refused`).
- **Unattended pass (Зп27–Зп30).**
  - `passUnattended(db, taskId, answers)` (`packages/db/src/scheduled-tasks.ts:1126`).
  - In such a pass the browser only reads on the client's site (`readOnly`, `BROWSER_READ_ONLY`; uncommitted `apps/browser/src/sessions/read-only-policy.ts`).
  - Pages are not changed, keyed skills are refused, and the turn gets an extra instructions section.
- **Setup in chat (Зп31–Зп35).**
  - MCP families `schedule` (`schedule_list`) and `schedule_changes` (create, update, delete, with `confirmedByClient`).
  - Changes are reserved at once and applied by `core` after the pass, like pages (`apps/mcp/src/schedule/*`, `apps/core/src/tasks/schedule-changes.ts`).
  - Feed rows `feed.schedule_change` and `feed.schedule_left`.
- **Notifications (Зп36–Зп43).**
  - Push is per browser. `notification_settings.push` is no longer read, and push subscriptions carry `vapid_key`.
  - A manifest for iOS, a navigation bridge in `sw.js`, and `notification-delivery.ts` shared with `ChatNotify`.
  - New kinds `not_started`, `paused`, `missed`.
  - Run chats get the mark «По расписанию · <название>».

**Database.** Migration `20261116120000_scheduled_tasks` (wt; applied only on throwaway databases):
- `scheduled_tasks`: `workspace_id`, **`site_id` → sites RESTRICT** (`migration.sql:41,107-108`), `created_by_id`, name, instructions, effort, triggers JSONB (at most 5), timezone, enabled, notify, `next_run_at`, `paused_reason` (`completed|project_gone|member_gone|not_accepted|refused`, :75), refusal streak, `created_via` (manual, template, chat), `source_task_id`, `deleted_at`.
- `scheduled_runs`: a snapshot of name, instructions and effort, plus **`site_id` → sites RESTRICT** (:123, :183-184). Reasons include `project_unavailable`, `project_gone` and `member_gone` (:139-141). Also `missed_count`, `missed_until`, `attempts`.
- `schedule_reservations`.
- `users.timezone`, `push_subscriptions.vapid_key`.
- `chat_notifications`: `task_id` becomes nullable, plus `scheduled_task_id`, `scheduled_run_id`, `attempt`, `turn_no`, and unique keys per pass and per run.
- One data deletion: push subscriptions of users who had turned push off (:33-35).

**Size.** About 258 files and +28.9k lines against the base (committed plus wt). About 940 changed lines sit in files that plan 83 deletes. The rest — domain `schedule/`, `core/schedules`, push, the mcp tools and the web section — does not depend on projects.

## 2. Every place plan 82 references the old site-project

- **Database.**
  - `site_id` on both tables, with RESTRICT foreign keys to `sites`.
  - `checkProject` uses raw `SELECT … FROM sites … FOR KEY SHARE` (`packages/db/src/scheduled-tasks.ts:268-273`).
  - `ScheduledTaskInput.siteId` (:315-334).
  - **Moving a task to another project** — «перенос задачи в другой проект» — is `patch.project` with the 20-task limit rechecked and `project_gone` lifted on move (:392-500, :476-479).
  - The list includes `site` (:584, 604, 620).
  - `countSiteSchedules`, `lockSiteSchedules`, `pauseSiteSchedules` (:650-680).
  - `snapshotOf.siteId` (:706-712).
  - Agent reservations must match `chat.siteId` (`lockChat` :1199-1213, `chatSchedule` :1218-1229, :1360-1364, :1599).
- **tRPC, `manage.ts`.**
  - `workspaceOf` goes through `accessibleSite` from `site-basics.ts` (`packages/trpc/src/services/schedule/manage.ts:44-46, 196-212`).
  - «Этому шаблону нужен проект» (:58-60, :216-220).
  - The move between projects (:270-300).
  - Cost hint by the site's workspace (:374-399).
  - `projectScheduleCount` (:441-453).
- **tRPC, `runs.ts`** (`packages/trpc/src/services/schedule/runs.ts`).
  - `project_gone` / `member_gone` read from `db.site` plus `memberRole` (:158-167, :243-251).
  - `createDialog({siteId, preview: 'on_demand'})` (:258-269).
  - `NOT_FOUND` is read again through the site (:278-280).
  - `TASK_NOT_ACCEPTED` with `site_not_active` maps to `project_unavailable` (:81-82).
- **Router.** `siteId` inputs in `packages/trpc/src/routers/schedule.ts:111-112, 143, 205`, and the procedure `projectCount` (:237-241).
- **`createDialog`.** Adds `title`, `preview: 'now'|'on_demand'` and `scheduledRunId`; uses `lockLiveSite` (`packages/trpc/src/services/chat/tasks.ts`, diff hunks at :137-160, :319-367).
- **Project deletion.** `site-delete.ts:3, 89-102, 211-265` locks the project's tasks, closes waiting run chats and pauses the tasks `project_gone`. The «Удалить проект» window shows the count (`site-danger-zone.tsx`).
- **Previews on demand (Зп18).** `packages/db/src/preview-on-demand.ts` (new), `core/previews/{preview-facts,preview-wake,preview-manager}.ts`, `mcp/content/mcp-journal.ts`, `mcp/browser/*` (`demandStoppedPreview`), `trpc/chat/previews.ts`.
- **Browser read-only (Зп28).**
  - `SiteAdapter`/`BrowserTaskPolicy.readOnlyDenied` (`packages/domain/src/ports/site-adapter.ts:492`, `packages/site-adapters/src/wordpress-browser-task.ts:91`).
  - `readOnlyPolicy` keyed to "the site" and to signing in with Б36 (wt `apps/browser/src/sessions/read-only-policy.ts:40-67`).
- **mcp.**
  - Tools take `project: 'this_chat'|'none'` (`packages/domain/src/schedule/tools.ts:90-101`).
  - `apps/mcp/src/schedule/schedule-service.ts:63, 199, 208, 254-257`.
  - The skill-relay refusal names «MCP-серверы проекта» — site skills, which plan 83 moved to the workspace.
- **Turn instructions.**
  - "a task about a site is set up in a chat of its project" (`apps/core/src/tasks/turn-instructions.ts:115-116`).
  - «Сохраните вход в админку в разделе «Переменные»» (:220). This is Б36, which plan 83 removes.
- **Domain.**
  - Templates: 5 of 6 need a site (`packages/domain/src/schedule/templates.ts:11-12, 48-98`).
  - The text of `member_gone` is «у вас больше нет прав в этом проекте» (`runs.ts:47, 85`).
  - The error `SCHEDULE_PROJECT_GONE` (`errors.ts:64`).
- **Web.**
  - `ProjectPicker` (import at `schedule-dialog.tsx:39`).
  - `ADD_PROJECT_HREF = '/projects/new'` (:75, :501-511).
  - The project filter and «Проект удалён» (`schedule-model.ts:76-118`, `scheduled-view.tsx:439-464`).
  - `SectionTabs` from `components/site/site-section` (`scheduled-view.tsx:22`).
  - The rail still keeps «Проекты».

## 3. Conflict with plan 83

`git merge-tree` of HEAD `feat/scheduled-tasks` against `origin/feat/remove-projects` (no files touched) gives **57 conflicted files**:
- **21 modify/delete.** For example: `core/previews/*`, `mcp/browser/*`, `mcp/content/*`, `chat/project-picker.tsx`, `site/site-danger-zone.tsx`, `trpc/services/site-delete.ts`, `site-basics.ts`, `chat/previews.ts`, and 7 project router tests.
- **36 content.** For example: `schema.prisma`, `db/src/index.ts`, `chat/tasks.ts`, `dialog-list.ts`, `feed.ts`, `task.ts`, `pass-facts.ts`, `turn-planner.ts`, `task-sweep.ts`, `core/config.ts`, `app.module.ts`, `mcp-access.ts`, `mcp-policy.ts`, `worker-session.ts`, `dialog-view.tsx`, `feed-list.tsx`, `web-env.ts`, `platform-secrets.mjs`, `.dependency-cruiser.cjs`, `CLAUDE.md`, `docs/spec.md`.

The uncommitted wt adds more on top of these.

There are also conflicts that merge cleanly as text but break in meaning:
- **Migration order.** Plan 83's `20261116110000_remove_projects` drops `sites` (`migration.sql:416`) and `tasks.site_id` (:338). Plan 82's `20261116120000_scheduled_tasks` sorts after it, then adds foreign keys `REFERENCES "sites"` → the migration fails.
- **Timestamp clash.** Plan 83 already has `20261116120000_credential_kind_mcp_server_workspace`, the same prefix as plan 82's migration.
- **Order 82 first.** Plan 83's plain `DROP TABLE "sites"` would be blocked by plan 82's RESTRICT foreign keys.
- **New files of plan 82 that import deleted modules.** `manage.ts` imports `../site-basics.ts`; `schedule-dialog.tsx` imports `chat/project-picker`; `scheduled-view.tsx` imports `site/site-section`; `db/scheduled-tasks.ts` uses raw SQL on `sites`.
- **`createDialog` in plan 83** takes no site, title, preview or run. Every chat goes to the personal workspace (`raditi-noprojects/packages/trpc/src/services/chat/tasks.ts:91-101, 163`).
- **Browser.** Plan 83 has only `OPEN_WEB_POLICY` (`packages/domain/src/browser/open-web.ts:93-96`). Зп28 ("read-only on the client's site") has nothing left to judge.
- **Skills** moved to `workspace_agent_skills` (БП11). Plan 82's unattended refusal in `skill-relay.ts` must be applied again to the workspace relay.
- **No conflict:** `chat_notifications` and `push_subscriptions` — plan 83 leaves them alone.

## 4. Owner's new screenshot vs what plan 82 built

| Screenshot (Claude project) | Plan 82 |
|---|---|
| Entry is in the project page's right column: «Запланировано · Добавить» | Only a global section `/scheduled` with «Новая задача ▾» («Настроить вручную» / «Настроить в чате»). A per-project list exists only as a filter. `listScheduledTasks` already filters by project (`db:591-604`) |
| Title «Новая запланированная задача», name, instructions | Same title. «Название» (placeholder «Например, «Проверка сайта»») and «Что сделать агенту» |
| «Авто» — Claude's permission mode (per task; cloud runs default to auto mode with a classifier) | Replaced by the project picker. Raditi's unattended rules (Зп28, Зп32) are fixed, not a choice |
| «Модель по умолчанию» | «Размышление»: низкое, высокое, максимальное (one model, GLM-5.3) |
| Trigger «Расписание / Ежедневно / 09:35» — a kind, then frequency, then time | «Когда запускать» goes straight to frequency and time: no kind level, no events. Up to 5 times. Seven frequencies including «Один раз», «Ежемесячно», «Только вручную». Claude's form offers Hourly, Daily, Weekdays and Weekly in the trigger, with Manual and Custom cron in Edit. Minute steps, so 09:35 works |
| «Дополнительные настройки» (Claude: «Only on this computer», folder, worktree) | Time zone only |
| — | Extras Claude lacks: next-run line, cost line, notify toggle with push, unattended warning, «Вместо этого настроить в чате», templates |

## 5. Recommended merge order and the minimal rebinding slice

**Order: 83 → 82 without projects → 84.** Plan 83 is validated and has its PR. Plan 82's migration was never applied outside throwaway databases, so it is the cheap one to rewrite. Plan 84 is still at the design-approval stage.

1. **Merge 83 as is.**
2. **Rebase 82 onto the new main as "82 without projects".**
   - Rename the migration after `20261116120100_workspace_agent_skills`.
   - Drop `site_id` from both tables, with their foreign keys and indexes.
   - Drop the preview-on-demand work (Зп18) and its seams in core and mcp.
   - Drop `site-delete` integration and `projectCount`, `ProjectPicker`, the project filter and `/projects/new`.
   - Drop Б36 wording and the stack's `readOnlyDenied`.
   - `createDialog` keeps only `title` and `scheduledRunId`.
   - mcp tools accept only `project: 'none'` (keep the enum).
   - Every task goes to the personal workspace, per Зп25.
   - Rewrite the templates for an everyday assistant.
   - Default: keep `project_gone` and `project_unavailable` in the CHECK lists as dormant values, so 84 needs no CHECK change.
3. **Rebind in plan 84 (the minimal slice).**
   - **Migration:** `scheduled_tasks.project_id UUID NULL REFERENCES projects` and `scheduled_runs.project_id` (snapshot), with indexes. Projects should be soft-deleted with `deleted_at`, so the RESTRICT plus `project_gone` design is reused.
   - **Rename seams `siteId` → `projectId`:** `checkProject` (against `projects`), `snapshotOf`, the list filter, `lockChat`/`chatSchedule` (`chat.projectId`), `workspaceOf`/`projectReasonNow` (an `accessibleProject` helper), router inputs.
   - **`createDialog({projectId, …})`.** Run chats then pick up project instructions, context and memory by themselves, because Зп17 makes them ordinary chats. The task snapshots only name, instructions, effort and project.
   - **Project deletion** calls `pause/lockProjectSchedules`.
   - **mcp:** `this_chat` is accepted again.
   - **Project page:** a «Запланировано» block: `schedule.list({projectId})` plus «Добавить», which opens `ScheduleDialog` with the project fixed and no picker.
   - **Global `/scheduled`:** keeps a project column and filter.
   - Estimate: about a day plus tests. The fixtures in the database and tRPC schedule tests switch from site to project.

## 6. Implications for Raditi projects

- Nearly all of plan 82 carries over. Only the narrow seams listed above depend on projects; everything else — domain, core, push and the rest — is unchanged.
- Unattended runs need rules for the new project powers. Зп32 refuses every `confirmedByClient` call in an unattended pass. So if 84's GitLab merge or CI tools and memory writes require `confirmedByClient`, scheduled runs cannot do them. That is right for merges and deploys; for memory, decide on purpose.
- The «Авто» slot can become Raditi's unattended mode: «Готовит и спрашивает» now, «Делает сам» later. This maps to the open §6 question in plan 82 (browser read-only versus allowing saves).
- Trigger kinds: plan 82 only knows `schedule` and `manual` (`scheduledRunTriggers`). GitLab event triggers (pipeline failed, MR opened) need a new trigger kind and a webhook intake. They are a natural follow-up to the GitLab integration, not part of the rebind.
- Workspace: plan 83 puts all chats in the personal workspace. `member_gone` stays valid but rarely fires. Its text should say «рабочем пространстве», not «проекте».

## 7. Questions for the owner (each with a proposed default)

1. **Merge order?** Default: 83 → 82 without projects → 84 with the rebinding slice.
2. **Global «Задачи» section as well as the project «Запланировано»?** Default: both. The global page lists every task with its project; the project page lists its own.
3. **«Добавить» in a project?** Default: the same window, with the project fixed and no project picker.
4. **«Авто» slot?** Default: «Режим» with one value «Готовит и спрашивает» (today's unattended rules). «Делает сам» only after your explicit yes.
5. **«Модель по умолчанию»?** Default: «Размышление», since there is one model.
6. **Trigger kinds?** Default: «Расписание» only. «Событие GitLab» after the GitLab integration lands.
7. **Deleting a project?** Default: soft delete. Its tasks pause as «Остановлена: проект удалён» and can be moved to another project or to «Без проекта». Run chats stay.
8. **Unattended runs and GitLab?** Default: they may read the repository and pipelines, commit to a branch and open a draft MR. They never merge and never start a deploy.
9. **Unattended runs and project memory or context?** Default: they read memory and context. They change neither, except through the automatic end-of-session memory mechanism if 84 adopts one.
10. **Browser read-only in unattended runs after plan 83?** There is no client site any more. Default: drop request-level read-only; keep refusing `web_upload` and "OK" in confirm dialogs; keep the instructions.
11. **Templates?** Default: six everyday templates without a project now, and 2–3 project or GitLab templates in 84.
12. **Tasks without a project?** Default: they stay at workspace level (personal workspace), visible only on the global page.
13. **Moving a task between projects?** Default: keep it, in the edit window of the global page.
14. **Limit?** Default: 20 enabled tasks per workspace, not per project.

Sources:
- [Claude Code Desktop — scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [Claude Desktop on 3P — scheduled tasks](https://claude.com/docs/third-party/claude-desktop/scheduled-tasks.md)
- [Claude Code — routines (cloud scheduled tasks)](https://code.claude.com/docs/en/routines.md)