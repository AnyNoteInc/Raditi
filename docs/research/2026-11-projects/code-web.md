# Web UI map for Claude-like projects (raditi-noprojects, after plan 83)

## Summary

The plan 83 tree already has most of the parts a Claude-like project needs. The cabinet frame (rail, optional left panel with «]», content card), the composer (files, effort, dictation, `/` commands), MUI dialogs with one look, settings-style sections, and an empty state drawn in CSS can all be reused. Two pieces are missing and have to be built: a right column of setting cards, and an "add context" menu. Code that still points at the old projects has to be removed or repointed: the rail link to `/projects`, its tests, and dead chat strings.

Scope: worktree `raditi-noprojects`, branch `feat/remove-projects`, HEAD `02c32c4d`. All files cited under `apps/web/src/components/{application,chat,account,pages}` and `packages/ui` are committed; the uncommitted changes there are in landing, legal and test files. Paths below are relative to `apps/web/src` unless they start with `apps/`, `packages/` or `docs/`.

---

## 1. Facts (file:line)

### 1.1 Rail and the dangling `/projects` link
- The rail has three sections: `components/application/application-rail.tsx:15-20` — «Чаты» `/chats` (icon `chat`), «Страницы» `/pages` (`pages`), «Проекты» `/projects` (`projects`).
  - The current item is found by `within()` at `:22-23`.
  - Items are 48×48 below `sm` and 60×56 from `sm`, with an 11px label (`:85-124`); the label is hidden on phones (`:117-123`).
  - The selected item is `background.paper` with an inset divider ring, and its icon is `primary.main` (`:106-112`).
  - `CreditRing` and `UserMenu` sit at the bottom (`:129-141`).
- No `/projects` route exists in `app/(protected)` (only `chats/`, `pages/`, `profile/`, `settings/`, `app/`). Clicking «Проекты» returns 404.
- Code and tests that still assert the link:
  - `components/application/application-rail.test.tsx:31-44` and `:51-52` (`/projects`, `/projects/new` marked current).
  - `components/application/application-shell.test.tsx:40-56` and `:84-94`.
  - `components/account/account-shell.test.tsx:21`.
  - e2e `apps/e2e/tests/site/chat.spec.ts:79-81`.
  - `app/robots.ts:22` (disallows `/projects`; harmless to keep).
- `components/application/application-shell.tsx:10-11`: the default crumbs are still `[{label:'Проекты'}]`. Its comment (`:13-15`) still says "the projects and a new project". Today only `/pages` uses it, with `toolbar={false}` (`app/(protected)/pages/page.tsx:18`).
- `UserMenu` has no «Проекты» item: «Чаты», «Профиль», «Настройки», «Использование» (`components/application/user-menu.tsx:173-197`).
- Plan 82 (`raditi-sched/apps/web/src/components/application/application-rail.tsx:25-31`) adds `{href:'/scheduled', label:'Задачи', name:'Запланированные задачи', icon:'timer'}` after «Чаты». It also adds an optional `name` field to sections. With that branch the rail becomes four items.

### 1.2 Cabinet frame: CabinetShell, CabinetPanel, «]»
- `components/application/cabinet-shell.tsx`:
  - `CabinetShell` (`:137-242`) props: `panel`, `panelState`, `panelWidth`, `skipTarget`, `railHiddenOnPhone`, `style`, `marks`, `sx`, `contentSx`, `frameSx`.
  - From `md` the content is a card: `background.paper`, radius 18 (`CABINET_RADIUS` `:32`), 10px gap (`:197-214`). A fixed frame over its edges keeps the corners while the page scrolls (`:215-238`).
  - The ground under the cards is `paper2`, or `ink` in dark mode (`cabinetGround` `:38-41`). Below `md` there are no cards.
  - `CabinetPanel` (`:72-85`) is the fixed left card next to the rail, hidden below `md`, with a `PanelResizer`. `cabinetPanelSx` is at `:54-69`.
  - `CONTENT_LEFT` (`:47`) = rail width plus panel width.
- `components/application/cabinet-panel.tsx`:
  - Panel state lives in the cookie `raditi-panel` (`lib/cabinet-panel.ts:8-44`). The width cookie is `raditi-panel-width`, default 284, range 240–440 (`lib/cabinet-panel.ts:50-77`).
  - The «]» key works outside text fields and when no MUI modal is open (`isPanelKey` `:72-78`). It is only active when `present` (`:98-107`).
  - `PanelToggle place="panel"|"content"` (`:121-150`) is a 44px icon button, shown only from `md`, tooltip `Скрыть панель (])` / `Показать панель (])`.
- `components/application/panel-drawer.tsx:13-75`: below `md`, a toolbar button that names the current section opens a left drawer (300px, `maxWidth 86vw`). The settings use it.
- `components/application/application-toolbar.tsx:18-92`: a 64px header with breadcrumbs, slots `start` and `end`, a bottom divider, and `linkUnderline` `always` or `hover`.
- `components/application/application-shell.tsx:17-53`: a page without a panel (rail + optional toolbar + `<main>`). Padding is 20/32/48 at `xs`/`sm`/`lg`, `py` 4/5.
- `components/account/account-shell.tsx:14-41` (the profile): no panel, content up to 864px wide.

### 1.3 How `/chats` groups chats (plan 61 «По проектам» is gone)
- `app/(protected)/chats/layout.tsx:26-40`: `ChatsShell` + `ChatsFrame`. Cookies are read on the server, so the first paint is correct.
- `components/chat/chats-shell.tsx:32-108`: `CabinetShell` with `panel` set to `true`, because the list draws itself. On a phone the rail is hidden for an item (`:59`). An open chat stands at window height from `lg` (`:70-80`). Content padding is 16/20/32 (`:90-91`).
- `components/chat/chats-frame.tsx:39-249`:
  - The list is a `<nav id=cabinet-panel>`, fixed from `md` (`:71-111`).
  - Head: «Чаты» (an `h1` while the list is the page, `h2` next to an item, `:116-129`), a search loupe that opens `SearchDialog` (`:130-140`), and `PanelToggle` (`:141`).
  - «Новый чат» is a contained pill, sticky at the bottom on phones (`:143-162`). Then `DialogList` (`:172`) and «Архив» pinned at the bottom (`:174-190`).
  - On phones, items get a back link «К чатам» (`:208-237`). The «]» show button stands over the content when the list is hidden (`:238-244`).
- `components/chat/dialog-list.tsx`:
  - Only one list remains: `DialogList` → `OneList` (`:410-414`, `:328-361`). Pinned chats come first (`:340-342`), then `dialogGroups()` → «awaiting / today / earlier» (`components/chat/chat-format.ts:47-65`, labels `taskListGroupLabel` in `packages/domain/src/tasks/client-feed-labels.ts:103`).
  - The query is `client.task.list.query({cursor, view})` through `useInfiniteQuery`, with a 15 s refetch (`:43-56`).
  - `task.list` input has no filter: `{cursor?, view?: 'active'|'archive'}` (`packages/trpc/src/routers/task.ts:375-395`).
  - A row (`DialogRow` `:220-266`) has a title, time, `StatusMark` and hint, «в архиве», «в Telegram», and a hover menu `DialogMenuButton` (Закрепить, В архив, Переименовать, Удалить) at `components/chat/dialog-actions.tsx:52-90`.
- Dead strings left over from plan 61: `chatsText.groupButton`, `groupTitle`, `groupList`, `groupProjects` («По проектам»), `attention`, `noProject` («Без проекта»), `pickerTitle`, `addProject`, `lockedProject`, `openProject`, `unavailableProject`, `importingProject`, `importFailedProject` (`components/chat/chat-texts.ts:362-381`). Each of the 12 checked has 0 uses.
  - `agentNotesText` (`:524-539`, «Подсказки агенту … этого проекта») is also unused.
  - `greetingLines` still has 'Что поменяем на сайте сегодня?' (`components/chat/chat-greeting.ts:34`).

### 1.4 `new-chat.tsx` and `composer.tsx`
- `NewChat` (`components/chat/new-chat.tsx:39-173`):
  - Props: `userId`, `userName`, `beside`, `speech`.
  - A centred column up to 780px wide, pinned to the bottom on phones, entering with `riseIn` (`:113-128`). The greeting is an `h1`/`h2` at 24/28px (`:130-142`, `useGreeting`).
  - It calls `task.create({taskId: uuidv7(), text, attachments?, effort})` (`:87-111`; input in `packages/trpc/src/routers/task.ts:125-145`). There is no project or context parameter.
  - Draft and history come from `takeChatDraft`/`readPromptHistory` (`:73-80`). The field is focused on open (`:83-85`). `UsageWindowHint` sits under the field (`:169`).
  - The composer is passed `commands.plain: true` and `effort={<EffortMenu …/>}` (`:144-168`).
- `Composer` (`components/chat/composer.tsx:201-264`):
  - Props: `label`, `placeholder`, `sendLabel`, `disabledReason`, `error`, `busy`, `onSend(text, attachmentIds) => Promise<boolean>`, `commands?: ComposerCommands` (`:176-189`), `effort?: ReactNode`, `attachments?: AttachmentsControl`, `noSecrets`, `fieldRef`, `stop`, `restored`, `restoredTaken`, `onTextChange`, `history`, `speech`, `mentions?: ComposerMentions` (`:168-174`). No caller passes `mentions` any more, so the plan 78 `@file` hook is dormant.
  - Look: a soft `action.hover` fill, radius 28, no frame (`:656-673`); a 2px accent inset while a file is dragged over; one calm ring on focus.
  - The dictation microphone is at the top right (`:675-726`) and turns into «Стоп» with a waveform while recording.
  - Field: textarea 16px, max height 30dvh/40dvh (`:758-815`).
  - Toolbar row, in order:
    - `/` «Команды» (`:820-832`);
    - a paperclip «Прикрепить файлы» (`aria-haspopup=menu`, `:833-844`) with a one-item `Menu` «Загрузить файл» plus a paste hint (`:847-878`) and a hidden `<input type=file multiple>` (`:880-893`);
    - `{effort}` (`:896`);
    - the send button: a 44px pill drawn smaller, accent fill (`:908-938`).
  - The header comment (`:191-200`) and `composerText.attach` (`chat-texts.ts:302-306`) say explicitly that the paperclip is not «+», because «+» is the tools of a dialog (plan 59, И15).
  - `fieldControl()` (`:82-109`) keeps a 44px hit area with a 32/36px drawn control.
  - Paste and drop attach files (`pastedFiles` `:127-132`, drop `:640-655`).
- Attachments: `useAttachments` (`components/chat/use-attachments.ts`) calls `attachment.start({name,size,type})` → PUT `/api/attachments/<id>` → ids. `attachment.start` is not bound to a task or a project (`packages/trpc/src/routers/attachment.ts:34-47`). Binding to a task: `attachment.bind({taskId, attachmentIds})` (`:74`).
  - Chips: `AttachmentChips({items,onRetry,onRemove})` (`components/chat/attachment-chips.tsx:152`), and `SentFiles` (`:288`).
- `EffortMenu` (`components/chat/effort-menu.tsx:35`): «Размышление» with «Низкое / Высокое / Максимальное» and hints (`chat-texts.ts:491-507`).
- `useDictation` (`components/chat/dictation.ts:119`) needs `speech` from `speechAvailable()` on the server.

### 1.5 Dialog view header and tools panel
- `DialogHead` (`components/chat/dialog-view.tsx:170-279`): a grid of title and actions, 44px high (56 from `lg`).
  - `PanelToggle place="content"` sits before the title (`:205-215`). The title is an `h1` at 15px/500 with an ellipsis (`:236-250`). Rename happens in place (`:216-225`).
  - On the right: the «Результаты» toggle, `DialogMenuButton`, and «+» tools while the panel is closed (`:254-273`). It is rendered at `:1248-1257`.
- `DialogView({taskId,title,browserStreamUrl,speech})` (`:285-300`). Tools state comes from `useReducer(toolsReducer, closedTools)` and starts closed on every showing (`:309-312`). `wide` = `lg` (`:315`).
- `components/chat/dialog-tools.ts:19`: tools are only `['browser','documents']` after plan 83.
- `components/chat/tools-menu.tsx:109`: «+» «Инструменты» is a two-column tile card (`Popover`, 500px wide) from `lg`. Below `lg` it is a bottom-sheet `Drawer`, max 560px, radius `24px 24px 0 0` (`:282-335`).
- `components/chat/tools-panel.tsx:62-…`: the landmark «Инструменты чата».
  - From `lg` it is a fixed right card the full height of the window (`:114-120`), with tabs (`tabSx` `:34-50`), a drag edge (`PaneResizer`), and «Скрыть панель».
  - Below `lg` it replaces the feed, with «К чату».
  - Width: `components/chat/pane-layout.ts:7` (`clamp(440px,46vw,760px)`), cookie `raditi-pane-width`. The shell is marked with `data-chat-pane-open` (`:15-17`).
- `components/chat/results-card.tsx`: «Результаты» is a 280px card pinned to the top right of the feed (`RESULTS_WIDTH` `:21`), hidden when the feed area is narrower than 984px. This is the closest existing "right column of cards".

### 1.6 Settings pages layout and form patterns
- `app/(protected)/settings/layout.tsx:14-27` → `SettingsShell` (`components/account/settings-shell.tsx:82-164`).
  - `CabinetPanel` «Настройки» with links (`SettingsLinks` `:25-75`): 44px rows, radius 10, selected `action.selected` with a `primary.main` icon.
  - `PanelDrawer` «Разделы настроек» on phones (`:127-133`).
  - Breadcrumbs only from `md` (`:142`). `<main>` up to 864px (`:145-161`).
- Section registry: `components/account/settings-nav.ts:12-21` — «Общее», «Тарифы», «Оплата», «Использование», «Переменные» (`lock`), «Навыки агента» (`brain`).
- Shared section styles (`components/billing/billing-surface.tsx`):
  - `surface` (paper, 1px divider, radius 14) `:12-17`;
  - `sectionPadding` 2.5/4 `:20`;
  - `pageHeading` 28/32px 600 `:23-29`;
  - `sectionHeading` 19px 600 `:32`;
  - `DetailRow` `:49-73`.
- «Общее» (`components/account/settings-panel.tsx:138-347`): one `Stack` surface with dividers (`:138-147`). Its sections:
  - «Тема оформления» (radio cards);
  - `<AgentInstructions/>` (`:222`);
  - notifications and Telegram;
  - «Новости и предложения» with a `Switch` in a 44px area (`:264-282`);
  - e-mail.
- «Инструкции агенту» (`components/account/agent-instructions.tsx:18-137`), per user (plan 76):
  - The section is an `h2` 17px/600 plus a hint, then a raw `<textarea rows=5>` (radius 12, divider border, `resize:vertical`, max 640px, `:72-101`).
  - «Сохранить» is disabled until there is a change. There is a counter `N из 2000` (`CLIENT_INSTRUCTIONS_LIMIT`, `packages/domain/src/agent/client-instructions.ts:5`).
  - Status texts: «Сохранено. Агент учтёт это со следующего ответа.» / «Инструкции убраны.».
  - tRPC: `user.agentInstructions`, `user.setAgentInstructions`.
- «Переменные» (`components/account/workspace-variables.tsx`):
  - texts `:29-64`; `pageHeading` + lead (`:214-219`); a `surface` section (`:223`) with a title, «Добавить переменную» and a note;
  - an inline form, not a modal (`VariableForm` `:75-170`: MUI `TextField` with `helperText`, password value, submit and «Отмена»);
  - removal through `ConfirmDialog`; tRPC `workspaceEnv.*`.
- «Навыки агента» (`components/account/agent-skills.tsx:30-…`, `WorkspaceAgentSkills` `:137`, `AgentSkills` `:157`):
  - a list with switches, an inline add form with a radio choice of auth («Нет» / «Ключ в заголовке» / «Вход через страницу сервера»);
  - OAuth starts with `POST /api/mcp-oauth/start` → `window.location.assign(authorizationUrl)` (`:199-214`), callback at `app/api/mcp-oauth/callback/route.ts`; secrets are kept in Vault (plan 81).
  - This is the existing pattern for linking an external account (GitLab).

### 1.7 MUI Dialog styling and existing modals
- No global `MuiDialog` override exists in `packages/ui/src/theme/create-app-theme.ts:103-146` (only Button, Paper, Card, Alert, Link). Default MUI paper radius comes from `shape.borderRadius: 14` (`:85`).
- `ConfirmDialog` (`components/billing/confirm-dialog.tsx:15-96`):
  - paper 480px, `p:3`, 1px divider border, radius 14;
  - an `h2` title at 20px/600;
  - an error `Alert` inside; buttons right-aligned (`keepLabel`, `confirmLabel`, `danger` → outlined error);
  - it cannot be closed while busy.
- `SearchDialog` (`components/chat/search-dialog.tsx:101-176`): `fullWidth maxWidth="sm"`, a `DialogTitle` with a 44px close «×», `DialogContent minHeight 360`.
- `ArchiveDialog` (`components/chat/archive-dialog.tsx:115,153`): the same shape.
- `PublishTargetDialog` (`components/chat/page-publish.tsx:177-314`): `fullWidth maxWidth="xs"`, a `<form>` inside, radio choice with indented fields, `DialogActions` «Отмена» / contained submit. The closest analogue to a create-project form.
- Page dialogs (`components/pages/page-actions.tsx`): `PagePasswordDialog` `:82`, `PageDeleteDialog` `:221`, `PagePlaceDialog` `:275` (title plus a fields form), `PageFilesDialog` `:415-523` (a file list with delete; the analogue of a "context files" list), `PageNameDialog` `:533`.
- Plan 82 `ScheduleDialog` (`raditi-sched/apps/web/src/components/scheduled/schedule-dialog.tsx:728-791`): `fullScreen={phone}`, paper 640px wide, `maxHeight calc(100% - 48px)`, a flex column, radius 14. It still uses the old `ProjectPicker` and `trpc.project.list` and links to `/projects/new` (`:39`, `:74-79`, `:174-177`).
  - `TriggerFields` (`…/trigger-fields.tsx:117`) covers «Один раз / Каждый час / Ежедневно / Еженедельно / Ежемесячно» with a time zone.
  - Texts (`…/schedule-texts.ts`): «Запланированные задачи», «Новая задача», «Настроить вручную», «Настроить в чате».

### 1.8 Empty states and illustrations
- `PagesEmpty` (`components/pages/pages-empty.tsx:126-213`) is the only cabinet empty state:
  - centred, max 560px, `mt` 6/10;
  - an illustration (`SiteMark`, `:21-118`) drawn with Boxes in theme colours — a browser window with bars that animate in, respecting reduced motion;
  - an `h2` at 22/26px/600, a secondary lead, a contained «Начать чат», and example requests as a list of buttons that put a draft through `keepChatDraft` (`components/chat/chat-draft.ts:11`) and go to `/chats/new`;
  - texts in `components/pages/page-labels.ts:159-177`.
- No SVG illustration exists in the cabinet. `<svg>` appears only in `components/application/app-icon.tsx`, `components/billing/credit-ring.tsx` and the landing (`landing-icons.tsx`, `site-demo.tsx`, `landing-lead.tsx`). Brand marks: `BrandMark`, `AnimatedBrandSymbol`, `BrandProgress` in `packages/ui/src/components/` (`BrandMark` exported via `index.ts`).
- The `/chats` empty list is plain text `listText.empty` (`chat-texts.ts:384`; `EmptyList` `dialog-list.tsx:363-369`).

### 1.9 `app-icon.tsx` icon names
`components/application/app-icon.tsx:3-91` (24-unit stroke paths, 1.7 width, `AppIcon({name,size=20})` at `:95`):

`projects` (a folder), `profile`, `pages`, `settings`, `plans`, `payment`, `usage`, `panel`, `paneHide`, `expand`, `results`, `logout`, `plus`, `search`, `microphone`, `pin`, `archive`, `sort`, `globe`, `arrow`, `chevron`, `down`, `download`, `close`, `back`, `send`, `check`, `clock`, `chat`, `changes`, `runs`, `database`, `more`, `lock`, `warning`, `slash`, `eye`, `file`, `document`, `forward`, `share`, `copy`, `contents`, `stop`, `terminal`, `folder`, `key`, `retry`, `attach`, `image`, `fullscreen`, `shrink`, `keyboard`, `pointer`, `pencil`, `trash`, `square`, `group`, `brain`.

Missing for the new screens: `timer` (plan 82 adds it), a git or branch icon, a memory icon, and a text/note icon (`contents` or `document` can stand in for the last).

### 1.10 Palette: no separate chat palette
- The cabinet and chat use only the brand theme: light background `paper #FFF8EC`, card `#FFFCF5`, text `ink #241710`, secondary text `graphite`, divider `rule`, primary `accentText #A63D12`. Dark: `ink` / `ink2`, `snow`, `accentLight` (`packages/ui/src/theme/create-app-theme.ts:15-52`; tokens `packages/ui/src/theme/tokens.ts:2-19`).
  - `action.hover` and `selected` are ink at 4% and 8% (`tokens.ts` `actionColors`).
  - A contained primary button is always `accent #FF6B24` with ink text (`create-app-theme.ts:117-134`).
- No "neutral chat palette" exists in either worktree. The chat composer uses `action.hover`; chats-frame uses `background.paper` and divider.
- DESIGN.md forbids local colour literals and any palette outside `tokens.ts` (`apps/web/DESIGN.md:425-442`, «Don't»).
- DESIGN.md is stale in places:
  - `:236` (`/projects` with `ApplicationShell`), `:244` (`site-shell.tsx`, deleted), `:129`;
  - `:393` describes the composer as a 1px `rule-strong` frame, radius 22, `background.default`, but the code is a fill with radius 28 and no frame (`composer.tsx:662-664`).
- PRODUCT.md `:15` says there are no projects since 15.11.2026.

### 1.11 Responsive behaviour (no bottom bar)
- Phones (< `sm`): the rail stays a 56px left column with icons only (`application-rail.tsx:92-93`, `:117-123`). There is no bottom navigation bar.
- An item that takes the whole screen hides the rail (`railHiddenOnPhone`, `cabinet-shell.tsx:143`, `:187`) and shows a back link («К чатам»).
- Below `md` the panel becomes `PanelDrawer` (left drawer) for settings. For chats the list becomes the root page.
- Below `lg` tools replace the feed, and the «+» menu becomes a bottom sheet.
- Hit areas are at least 44px throughout (rail, toggles, composer, menu items `minHeight 44`). Safe-area insets are respected.
- MUI breakpoints are the defaults (`md` 900, `lg` 1200).

### 1.12 tRPC client pattern
- Setup: `trpc/client.tsx:14` exports `TRPCProvider`, `useTRPC`, `useTRPCClient` (from `createTRPCContext<AppRouter>`). `httpBatchLink` plus `httpSubscriptionLink` with superjson, and `consentRedirectLink` (`:20-46`). The provider is mounted in `app/(protected)/layout.tsx:19`.
- Two idioms:
  - `const trpc = useTRPC(); useQuery(trpc.x.y.queryOptions(input)); useMutation(trpc.x.y.mutationOptions())`, then `queryClient.invalidateQueries({queryKey: trpc.x.y.queryKey()})` (agent-instructions, workspace-variables, page dialogs);
  - `useTRPCClient()` with raw `client.task.list.query()` inside `useInfiniteQuery` (`dialog-list.tsx:43-56`, `search-dialog.tsx:101-113`).
- Routers: `packages/trpc/src/router.ts:16-35` — health, user, consent, notification, telegram, billing, task, browser, attachment, document, pages, workspaceEnv, agentSkills. There is no project router.
- Errors surface through `callErrorText` / `callErrorCode` (`components/chat/call-error.ts`).
- Server pages call `requireSession()` and return `ServiceUnavailable` on `UNAVAILABLE`. Cookies are read in layouts so the first paint is correct.

---

## 2. Implications for Raditi projects

### Routes and shell
- **`/projects`** (list and empty state):
  - Option 1: `ApplicationShell toolbar={false}` + a `PagesView`-style container (max 1200, a heading row with a contained «Новый проект» pill as at `pages-view.tsx:233-245`).
  - Option 2, closer to Claude: `CabinetShell` with a `CabinetPanel` list of projects, so «]» works.
  - Recommendation: no panel, like `/pages`. Claude's project list is a page of cards. Reuse the `app-project-card` token (radius 14, padding 24) still in the DESIGN.md frontmatter.
- **`/projects/[id]`**: a page where the composer for a new project chat sits over the list of that project's chats, with a right column of setting cards. Two options:
  - Option 1: a page on `ApplicationShell` with a two-column grid (main up to ~780px, right column ~320px). Below `lg` the right column stacks under the main column; on phones the setting cards go into an accordion or a drawer.
  - Option 2: `ChatsShell` with a project-scoped list in the panel.
  - Recommendation: option 1. Opening a chat goes to the existing `/chats/[taskId]`. The `DialogHead` gains a crumb or pill «Проект X» that links back (`dialog-view.tsx:203-253` has room before the title).
- **Rail**: keep «Проекты» at `/projects` (`application-rail.tsx:19`). Once the route exists, the existing tests (`application-rail.test.tsx:31-59`, `application-shell.test.tsx`, `account-shell.test.tsx:21`, `apps/e2e/tests/site/chat.spec.ts:79-81`) become true again. With plan 82 the order becomes «Чаты, Задачи, Страницы, Проекты». Fix the `PROJECTS_CRUMBS` default and comment in `application-shell.tsx:10-15`.

### Component reuse
| New piece | Reuse | Change |
| --- | --- | --- |
| Empty «Проекты» («Хотите создать проект?» + «Новый проект») | `PagesEmpty` layout (`pages-empty.tsx:126-213`): centred, an illustration drawn with Boxes in theme colours (`SiteMark` pattern), an `h2`, the lead, a contained pill | A new illustration in the same Box/CSS style, for example a folder with sheets (no SVG asset pipeline exists; `AppIcon` paths or Boxes) |
| Create-project modal («Над чем вы работаете?», «Чего вы хотите достичь?», «Контекст — необязательно» + «Добавить контекст») | `PublishTargetDialog` form-in-dialog (`page-publish.tsx:228-312`) or the `ScheduleDialog` frame (640px, `fullScreen` on phone, radius 14; `schedule-dialog.tsx:751-791`); `TextField`s as in `VariableForm`; `ConfirmDialog` button order | Files: `useAttachments` + `AttachmentChips` (upload is unbound, `attachment.ts:34-47`, so files can be uploaded before the project exists and then bound to the project, like `attachment.bind` for a task) |
| Project page composer «Новая сессия в проекте X» | `NewChat` + `Composer` unchanged (`new-chat.tsx:144-168`), with `riseIn` and the greeting | `task.create` needs a `projectId` (`task.ts:125-145`); the placeholder or heading names the project |
| Project chats list | `DialogRow`, `DialogGroup` and `ListLoading` from `dialog-list.tsx`; `DialogMenuButton` | `task.list` needs a project filter (`task.ts:375-382`); export the row parts |
| Right column «Инструкции / Контекст / Память / Запланировано» | Section look `surface` + `sectionHeading` (`billing-surface.tsx:12-32`); a card as narrow as the «Результаты» card (280px, `results-card.tsx:21`); `Skeleton`, `Alert` | Cards open modals for editing (Claude-like); show a summary or an empty line inside each card |
| «Инструкции» modal or card | `AgentInstructions` almost whole (`agent-instructions.tsx:29-137`: textarea, counter, «Сохранить», status texts) | Parametrise the query and mutation and the texts; keep the 2000 limit; the account instructions keep living in «Общее» |
| «Контекст» card and «Добавить контекст» menu (upload / text / GitHub / GitLab) | The composer's attach `Menu` (`composer.tsx:847-878`: MUI `Menu`, radius 14, items with icon, primary and secondary text), the hidden `<input type=file multiple>`; `PageFilesDialog` for the list of files with delete (`page-actions.tsx:415-523`); `AgentSkills` OAuth start for GitLab (`agent-skills.tsx:199-214`, `/api/mcp-oauth/*`) | A new menu with four items; a «Текст» modal (title + textarea); a GitHub link field; a GitLab connect flow through Vault (plan 81 pattern) |
| «Память» modal («Память пока пуста…», «Использовать память аккаунта») | The `Switch` row pattern from «Новости и предложения» (`settings-panel.tsx:228-323`: 44px switch, live status); `AgentMarkdown` to show memory text (`agent-markdown.tsx:212`) | Depends on the OpenCode memory research (separate task) |
| «Запланировано» card and «Новая запланированная задача» | Plan 82: `ScheduleDialog`, `TriggerFields`, `schedule-texts.ts`, `ScheduledEmpty` (raditi-sched) | Replace `ProjectPicker` and `trpc.project.list` and `/projects/new` (`schedule-dialog.tsx:39,74-79,174-177`) with new project ids; preselect the current project |
| Icons | `AppIcon` (`projects`, `plus`, `file`, `document`, `attach`, `folder`, `key`, `terminal`, `clock`, `brain`, `contents`) | Add `timer` (from plan 82), a git/branch icon, a memory icon |

### Rules that affect copy and layout
- Rule 10 (Russian, «вы», no jargon or English terms):
  - «Сессия» is foreign to the product, where the unit is «чат» (all of `chat-texts.ts`; PRODUCT.md `:81` uses one word per action).
  - «Контекст», «CI/CD», «мердж», «пайплайн» and «репозиторий» are jargon for the small-business user (PRODUCT.md `:9-11`).
  - GitLab and GitHub are brand names and can stay.
- «Инструкции»: the existing wording is «Инструкции агенту» (`agent-instructions.tsx:19`) and «Навыки агента». The cabinet already says «агент»; the «not "агент"» rule (PRODUCT.md `:79`) is for visitor texts.
- One accent pill per screen (contained primary = `accent`). Secondary actions are outlined or text. Take colours from `tokens.ts` only (DESIGN.md `:425-442`). A Claude-like look has to come from layout, density and type, not new hues. The warm cream and ink palette is already close to Claude's own warm neutral look; this is general knowledge, not checked against a source.
- 44px hit areas, keyboard focus rings (`applicationSurface` `:6-10`), reduced motion, and server-correct first paint (cookies read in layouts).
- The «]» key is ignored while a MUI modal is open (`cabinet-panel.tsx:77`), so the new modals need no extra handling.
- `noSecrets` reminder (`chat-texts.ts:568-569`): project instructions, text context and GitLab tokens need the same «не пишите пароли и ключи» hint, and secrets go to Vault (rule 2).
- Clean up when projects come back:
  - the dead `chatsText.*Project*` and group strings (`chat-texts.ts:362-381`), `agentNotesText` (`:524`), and the greeting line about the site (`chat-greeting.ts:34`) — remove them or repurpose them deliberately;
  - DESIGN.md `:236` and `:244`, and PRODUCT.md, need rewriting for the new projects.

---

## 3. Questions for the owner (each with a proposed default)

1. **Word for a project chat.** Should it be «Новая сессия в проекте X» or «Новый чат в проекте X»?
   - Default: «Новый чат в проекте X», because «чат» is the product word (rule 10).
2. **Name of «Контекст».** Keep «Контекст» or use plain words?
   - Default: section «Материалы проекта», button «Добавить материалы», hint «Файлы, тексты и ссылки, которые агент читает в каждом чате проекта». Keep «Контекст — необязательно» only if you want it word for word like Claude.
3. **Where a project chat opens.** On the project page or in «Чаты»?
   - Default: in the existing `/chats/[taskId]` with a «Проект X» link in its head. It also appears in «Чаты» marked with the project name.
4. **«По проектам» in the chat list.** Bring back the plan 61 grouping?
   - Default: no. Show a small project label on each row, plus a project filter later.
5. **Project list layout.** Cards or a list?
   - Default: Claude-like cards (name, description, last chat date), one to three columns, sorted by last activity, with a search field from 7 projects up (as plan 61 did).
6. **Right column on phones and tablets.**
   - Default: below `lg` the cards stack under the chat list; on phones each card is a row that opens its modal full-screen (`fullScreen` as in plan 82).
7. **Instructions order.** Do project instructions add to the account instructions «Инструкции агенту» or replace them?
   - Default: both go to the prompt, account first, then project, each up to 2000 characters.
8. **«Добавить контекст» menu items.**
   - Default: «Загрузить файлы», «Добавить текст», «Ссылка на GitHub», «Подключить GitLab». The GitLab item opens connection settings; merges, CI and pipelines live in a separate «Репозиторий» card or tab shown once GitLab is linked.
9. **Paperclip or «+» in the composer.** Change the composer's paperclip to «+» now, as on the pending «+» menu canvas?
   - Default: keep the paperclip in chats (plan 59, И15). Use «+» only for «Добавить контекст» on the project page.
10. **Rail order with plan 82.**
    - Default: «Чаты, Задачи, Проекты, Страницы», moving «Проекты» up next to work items. Alternative: keep «Страницы» before «Проекты» as now.
11. **Scheduled tasks scope.** Should project tasks also show in the global «Задачи» (`/scheduled`, plan 82)?
    - Default: yes, with a project filter. The project card shows only that project's tasks, and «Новая задача» from it preselects the project.
12. **Empty-state illustration.**
    - Default: an illustration drawn in theme colours like `SiteMark` (a folder with three sheets, a light entrance animation, none under reduced motion), plus two or three example projects that prefill the create modal.