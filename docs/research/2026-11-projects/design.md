# Visual brief: Raditi cabinet style for the new «Проекты» screens

Everything below was read from `raditi-noprojects` (branch `feat/remove-projects`, HEAD `02c32c4d`). In that tree the theme (`packages/ui/src/theme/*`) and `apps/web/src/components/application/*` are byte-identical to `origin/main` `1e18088c`. I took a few extra precedents from `origin/main` (the old projects page) and from `raditi-sched` (plan 82). No files were edited. The blended values marked "≈" I worked out with a small script.

## 1. Facts

### 1.1 Palette (source of truth)

- **Brand constants** (`packages/ui/src/theme/tokens.ts:2-19`). These are the same in both themes and are emitted as `--raditi-*` variables (`tokens.ts:132-139`, wired in at `create-app-theme.ts:104-106`):
  - paper `#FFF8EC`, paper2 `#F3E7D5`, card `#FFFCF5`
  - ink `#241710`, ink2 `#352217`, graphite `#695547`
  - rule `#E1CDB6`, marker `#FFC547`
  - accent `#FF6B24`, accentText `#A63D12`, accentLight `#FFB86B`
  - ok `#79573B`, onInk `#C6AE95`, ruleInk `#5A3C28`, snow `#FFF1DE`
- **Light palette** (`create-app-theme.ts:15-32`):
  - background.default `#FFF8EC`, background.paper `#FFFCF5`
  - text primary `#241710`, secondary `#695547`, disabled `rgba(36,23,16,.38)` (≈`#ACA59E`)
  - divider `#E1CDB6`
  - primary.main `#A63D12` with white contrast text
- **Dark palette** (`create-app-theme.ts:35-52`):
  - background.default `#241710`, background.paper `#352217`
  - text primary `#FFF1DE`, secondary `#C6AE95`, disabled `rgba(255,241,222,.38)` (≈`#827163`)
  - divider `#5A3C28`
  - primary.main `#FFB86B` with ink contrast text
- **Status tones** (`tokens.ts:22-35`):
  - Light: success `#79573B`, error `#9C3D26`, warning `#92551E`, info `#A63D12`.
  - Dark: success `#D6B495`, error `#F09B7C`, warning `#E6BA7E`, info `#FFB86B`.
  - Status dots, both themes (`tokens.ts:41-46`): ok `#2E9F62`, waiting `#C77F0A`, broken `#D9482B`, off `#8C8072`.
- **Action colours** (`tokens.ts:55-82`):
  - Light: hover `rgba(36,23,16,.04)` (≈`#F6F3EC` on card), selected `rgba(36,23,16,.08)` (≈`#EDEAE3`), disabledBackground `rgba(36,23,16,.12)`.
  - Dark: hover `rgba(255,241,222,.08)` (≈`#453327` on ink2), selected `rgba(255,241,222,.16)` (≈`#554337`).
- **Roles** (`tokens.ts:85-107`):
  - accentHover = `color-mix(accent 65%, marker)` ≈ `#FF8B30`
  - ruleStrong ≈ `#8D7968`, meant for control outlines in light only
  - accentSoft ≈ `#FFE1CC`, a light value with no dark counterpart
  - onAccent = ink `#241710`
- **Cabinet ground under the cards** (`apps/web/src/components/application/cabinet-shell.tsx:38-41`): light paper2 `#F3E7D5`, dark ink `#241710`.
  - From 900px (md) the rail sits on the ground; the panel and the content are cards of background.paper (`cabinet-shell.tsx:54-69`, `197-211`).
  - Below 900px there are no cards: the content is paper right to the edges (`cabinet-shell.tsx:116-122`).
- **Raised surfaces** have no lighter tone of their own: `MuiPaper` sets `backgroundImage:none` (`create-app-theme.ts:136-138`), so MUI's dark elevation overlay is gone.
  - Menus and dialogs are background.paper: `#FFFCF5` in light, `#352217` in dark, the same colour as the card. They are told apart only by shadow and a 1px divider border.
- **Contrast checks:**
  - Focus ring on card: 6.21:1 in light, 8.85:1 in dark.
  - Ink on accent: 6.12:1; ink on accentHover: 7.46:1.
  - Dark text-secondary on a selected row drops to 4.41:1, which is why the selected chat row switches its quiet text to text.primary (`chat/dialog-list.tsx:119-121`).

### 1.2 Typography

- **Fonts:** Golos Text Variable, Unbounded Variable and JetBrains Mono Variable, self-hosted through fontsource (`apps/web/src/app/layout.tsx:1-3`, variables in `globals.css:3-4`).
  - Theme stacks (`tokens.ts:145-149`): body is Golos, headings are Unbounded, mono is JetBrains.
  - All three families are also on Google Fonts, which suits HTML boards.
- **MUI scale** (`create-app-theme.ts:87-102`):
  - h1–h6 use Unbounded 600: h2 is 2.25rem / 1.1 / −0.03em, h6 is 1.0625rem / 1.3 / −0.01em.
  - Buttons are 600, no uppercase, letter-spacing 0, 14px by MUI default.
  - body1 16/1.5, body2 14/1.43, caption 12/1.66 (MUI defaults).
- **Page title — the code is split:**
  - «Страницы» uses `variant="h2"`, which is Unbounded 600 at 26px (xs) / 30px (md), line-height 1.2 (`components/pages/pages-view.tsx:144-149`). The old «Проекты» page on main did the same (`origin/main:apps/web/src/components/projects/projects-view.tsx`, the `variant="h2"` heading).
  - Settings pages use Golos 600 at 28/32, −0.025em (`components/billing/billing-surface.tsx:23-29`). `DESIGN.md:224` says app page titles are Golos.
- **Section title:** Golos 600, between 16 and 19px:
  - 17px in instructions, notifications and skills (`account/agent-instructions.tsx:55`, `account/agent-skills.tsx:124`)
  - 19px for billing sections (`billing-surface.tsx:32`)
  - 16px in panel headings (`account/settings-shell.tsx:108`) and schedule rows
- **Body:** 15–16px.
  - Composer textarea 16/1.65 (`chat/composer.tsx:807-808`).
  - Settings textarea 15/1.6 (`agent-instructions.tsx:96-97`).
  - Hints are body2 14px in text.secondary.
- **Caption:** 12px in text.secondary. List times, group labels and chat-list second lines are 12px; menu secondary lines are 13px.
- **Dialog titles — two patterns:**
  - Custom h2 in Golos 20/600/1.3, used by ConfirmDialog and plan 82's ScheduleDialog (`billing/confirm-dialog.tsx:66-72`, `raditi-sched:apps/web/src/components/scheduled/schedule-dialog.tsx:359-363`).
  - MUI `DialogTitle`, which renders h6, i.e. Unbounded 17px. Used by «Поиск чатов» and «Архив» (`chat/search-dialog.tsx:128`).

### 1.3 Radii

| Element | Radius | Source |
| --- | --- | --- |
| Cabinet cards (panel, content, tools pane) | 18 | `cabinet-shell.tsx:32`, `chat/tools-panel.tsx:123` |
| Theme default, MUI Paper and Dialog, outlined fields, Menu, Tooltip | 14 | `create-app-theme.ts:85` |
| Inner surfaces of a page | 14 | `billing-surface.tsx:12-17` |
| Menus (set explicitly) | 14 | `composer.tsx:855`, `chat/effort-menu.tsx:92` |
| Rail item | 14 | `application-rail.tsx:99` |
| Tiles, tool tiles, file chips, settings textarea | 12 | `chat/tools-menu.tsx:56`, `chat/attachment-chips.tsx:27`, `agent-instructions.tsx:90` |
| List rows, nav rows, search field | 10 | `dialog-list.tsx:139`, `settings-shell.tsx:54`, `chat/chat-search-field.tsx:36` |
| File icon tile | 8 | `attachment-chips.tsx:40` |
| Composer | 28 | `composer.tsx:663` |
| Soft instructions field (plan 82) | 20 | `schedule-dialog.tsx:420` |
| Every button, pill and mark | 999 | `create-app-theme.ts:120`, `tokens.ts:111` |
| MUI `Card` (unused in the cabinet) | 22 | `create-app-theme.ts:141` |

### 1.4 Frame, spacing and breakpoints

- **Breakpoints** are MUI defaults: sm 600, md 900, lg 1200, xl 1536. The base spacing unit is 8px.
- **App tokens** (`apps/web/DESIGN.md:87-108`):
  - rail 72, compact rail 56
  - cabinet panel 284 with radius 18; its edge can be dragged from 240 to 440 (`lib/cabinet-panel.ts:51-53`)
  - gap 10, toolbar 64, navigation item 44 with radius 12
  - project card radius 14, padding 24
- **Content padding:**
  - Chats: x 16 / 20 / 32 (xs / sm / md), y 24 / 28 (`chat/chats-shell.tsx:90-91`).
  - ApplicationShell main: x 20 / 32 / 48 (xs / sm / lg), y 32 / 40 (`application/application-shell.tsx:43-44`).
  - «Страницы» adds x 16 / 32 and y 16 / 28 inside that, with max width 1200 (`pages-view.tsx:224-231`).
  - Settings column: max width 864, x 20 / 32, top 32 / 40 (`settings-shell.tsx:149-157`). Section padding is 20 / 32 (`billing-surface.tsx:20`).
  - Stacked form fields sit 20px apart (`account/workspace-variables.tsx:121`).
- **Toolbar** is 64px high with a divider underline (`application/application-toolbar.tsx:43-49`). «Страницы» runs without it (`app/(protected)/pages/page.tsx:19`).
- **Hit area** is at least 44px everywhere; a smaller shape is drawn inside it (`composer.tsx:75-106`).

### 1.5 Elevation

- Cards carry no shadow; borders and fields build the hierarchy (`DESIGN.md:292`).
- MUI Menu uses elevation 8: `0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12)`.
- MUI Dialog uses elevation 24: `0 11px 15px -7px rgba(0,0,0,.2), 0 24px 38px 3px rgba(0,0,0,.14), 0 9px 46px 8px rgba(0,0,0,.12)`. Both shadows were checked in MUI 9.4 `styles/shadows.js`.
- The command palette uses its own `0 8px 24px -12px rgba(0,0,0,.18)` with a 16px radius (`chat/command-palette.tsx:191-196`).
- The dialog backdrop is MUI's `rgba(0,0,0,.5)`.

### 1.6 MUI components as they render

There are no theme overrides for Dialog, OutlinedInput, Switch, Menu, Tooltip or Chip.

- **Button:**
  - Every button is a pill.
  - Contained primary: fill `#FF6B24`, ink text `#241710`, 1px `#A63D12` border, hover `#FF8B30`, the same in both themes (`create-app-theme.ts:117-134`).
  - Medium: min height 44, horizontal padding 18. Large: 52 with horizontal padding 26 at 16px.
  - Text and outlined buttons use primary.main for text (`#A63D12` / `#FFB86B`); the outlined border is primary at 50%.
  - Header buttons are 40 high («Новый чат» on «Страницы», `pages-view.tsx:236-244`).
- **Dialog:**
  - Paper radius 14, margin 32.
  - The app adds a 1px divider border, padding 24, width 480 (`confirm-dialog.tsx:51-64`); `maxWidth="sm"` gives 600 (`search-dialog.tsx:127`); the schedule dialog is 640 with margin 24 (`schedule-dialog.tsx:758-775`).
  - Actions sit on the right: a text «Отмена» button, then a contained one.
  - On a phone the dialog goes full screen (`schedule-dialog.tsx:757`).
- **TextField (outlined):**
  - 56px high (40 small), radius 14, transparent background.
  - Border `rgba(0,0,0,.23)` in light (≈`#C4C2BD`), `rgba(255,255,255,.23)` in dark (≈`#63554C`). Hover border is text.primary; focus is 2px primary.main.
  - Label goes from 16px to 12px in text.secondary; helper text is 12px.
- **Switch:**
  - Root 58×38, track 34×14 with radius 7, thumb 20.
  - On: thumb is primary (`#A63D12` / `#FFB86B`), track is primary at 50% (≈`#D39D84` / `#9A6D41`).
  - Off: thumb `#FFFFFF` / `#E0E0E0`, track black at 38% (≈`#9E9C98`) / white at 30% (≈`#72645D`).
  - The settings rows wrap it as `height 44, py 15px` (`account/notification-settings.tsx:107-114`).
- **Menu:**
  - Paper radius 14, minimum width 240–260, background.paper.
  - Items: gap 12, vertical padding 8, primary line 14/500, secondary line 13 in text.secondary, selected = action.selected, a check icon 18 on the right (`effort-menu.tsx:105-133`).
- **Tooltip:**
  - MUI default `rgba(97,97,97,.92)` with white 11px/500 text, padding 4px 8px. Its radius inherits 14, because `shape.borderRadius` is 14.
  - «Страницы» overrides it to padding 12, 13px / 1.45 (`pages-view.tsx:159`).
- **Chip:**
  - MUI default 32 high (24 small), radius 16, filled with action.selected.
  - In the app: small outlined, min height 26, 12px. Tool "marks" are 24 high, pill, filled with divider, 12.5/500 (`tools-menu.tsx:83-97`).
- **Focus:**
  - Page-wide: 2px solid primary.main, offset 3px (`application/application-surface.ts:6-10`).
  - Inside fields and rows: offset 2 or −2.
  - Composer: no outline, an inset `0 0 0 1px rgba(text.primary,.24)` instead (`composer.tsx:668-672`).

### 1.7 Anatomies

**Rail** (`application/application-rail.tsx:40-141`):
- Fixed, 72 wide (56 on a phone).
- From 900px it is transparent over the ground; on a phone it is background.default with a right divider.
- Top padding 12. The brand mark is 30px in a 44 box, then 24px of space below it. The mark is an amber `#FFC547` circle with an ink asterisk drawn at stroke 8.3/60 (`packages/ui/src/components/brand-symbol.tsx:27-34`).
- Items are 60×56 (48×48 on a phone), radius 14, 6px apart.
  - Icon 20 above a label at 11/14px weight 500 in text.secondary, 4px between them.
  - Hover: action.hover with text.primary.
  - Current item from 900px: background.paper with an inset 1px divider ring, label weight 600, icon in primary.main. Current item on a phone: action.selected.
- Sections: «Чаты» (`chat`), «Страницы» (`pages`), «Проекты» (`projects`), at `application-rail.tsx:15-20`.
- Bottom of the rail, 6px apart:
  - Credit ring: a 44 button with a 28 ring, stroke 3, the arc in primary.main over a divider track (`billing/credit-ring.tsx:202-219`).
  - Avatar 30, filled primary.main with contrast text (`application/user-avatar.tsx:41-51`, `application/user-menu.tsx:112`).
- In this worktree «Проекты» still links to `/projects` (`application-rail.tsx:19`), but `apps/web/src/app/(protected)/` has no `projects` route.

**Chats panel** (`chat/chats-frame.tsx:71-190`):
- A fixed card: top and bottom 10, left at the rail edge, width 284, padding x 12 and top 12, radius 18, divider border.
- Header row:
  - title «Чаты» in Golos 18/600 with 12px left padding
  - loupe button 44, icon `search` 18, text.secondary
  - «]» toggle 44, icon `panel` 20
- «Новый чат»: a contained pill 44 high with a `plus` 18, full width.
- Then the list.
- Pinned to the bottom: «Архив», 44 high, radius 10, icon `archive` 16, 14px in text.secondary (`dialog-list.tsx:375-402`).

**Chat list row** (`chat/dialog-list.tsx:117-213`):
- A link, min height 40 (44 on a phone), padding x 10 and y 6, radius 10.
- Line 1: the title at 14px (500 when current, 400 otherwise), line-height 1.45, ellipsis; the time as a 12px caption in text.secondary, flush right.
- Line 2: a status mark (icon 13 plus a 12–13px word, in the tone of the status, `chat/status-mark.tsx:13-41`) and hints joined with « · », such as «в архиве» and «в Telegram».
- Current = action.selected; hover = action.hover.
- On hover, a «⋯» menu replaces the time (`dialog-list.tsx:229-232`).
- Rows are 2px apart. Groups are 12px apart, each with a 12px/500 label in text.secondary («Закреплённые», …).

**Composer** (`chat/composer.tsx:591-940`):
- Wrapper: a column, 6px between rows.
- Field box: padding 10, radius 28, filled with action.hover, no border.
  - Focus: inset 1px ring at text.primary 24%.
  - Dragging files in: inset 2px accent ring plus an overlay «Отпустите, чтобы прикрепить».
- Textarea: min height 44, max 40dvh (30dvh on a phone), padding x 10 and y 8, 16/1.65, placeholder in text.secondary.
  - New chat placeholder: «Что нужно сделать?» (`chat/chat-texts.ts:295`).
- Microphone «Надиктовать»: absolute, top 6, right 6. Hit area 44, drawn circle 32 (36 under a finger), icon 18.
- Bottom row, left to right:
  - «/» «Команды» (icon `slash` 18)
  - paperclip «Прикрепить файлы» (`attach` 18), opening a menu: «Загрузить файл» plus a paste hint
  - «Размышление»: a quiet pill with `brain` 17, the level word («Низкое» / «Высокое» / «Максимальное») at 13px in text.secondary, and `down` 14 (`effort-menu.tsx:56-83`)
- Right end: «Отправить», a 44 hit area with a 32 circle filled accent `#FF6B24`, arrow `send` 18 in ink.
  - Disabled: action.disabledBackground at 0.22 opacity.
  - While the agent works it becomes «Остановить» with icon `square`.
- Collapsed height: 10 + 44 + 4 + 44 + 10 = **112px**. No permanent text sits under the field; errors appear as body2 lines in error.main.
- In the open chat, «+» is the separate «Инструменты» button in the head: 44 hit area, an inner 36 frame (inset 4) with radius 10 and a 1px divider border, `plus` 20 in text.primary, an optional 14px dot in primary.main (`chat/tools-menu.tsx:239-282`).
- The owner chose the paperclip over a second «+» on 29.10.2026 (plan 59, И15). A canvas «Плюс в поле чата» that would bring «+» back into the field is still waiting for the owner.

**New chat screen** (`chat/new-chat.tsx:113-171`):
- A column up to 780 wide, centred from 600px and pinned to the bottom on a phone, 24px between parts.
- Greeting: Golos 24 (xs) / 28 (sm), weight 500, −0.01em, centred («Добрый вечер…», `chat/chat-greeting.ts:22-35`).
- Then the composer, then the usage hint.

**Open chat head** (`chat/dialog-view.tsx:190-250`): min height 44 (56 from 1200px); the title is an h1 at 15/500, ellipsis.

**Settings form rows:**
- Inline textarea: 1px divider border, radius 12, padding 12, 15/1.6, max width 640. Under it: a contained «Сохранить» 44 and a counter caption on the right (`agent-instructions.tsx:72-122`).
- Switch rows: a label at 15/500 over a body2 hint, the switch on the right (`notification-settings.tsx:95-104`).
- List rows: padding y 14 and x 22, 1px divider between rows, title 600, body2 description, the switch flush right (`agent-skills.tsx:299-453`).
- Variables: a monospace name at 15px over an «updated» line, with an outlined small «Заменить значение» and an error-coloured «Удалить» (`workspace-variables.tsx:300-345`).

**File chip** (`chat/attachment-chips.tsx:18-52`):
- Min height 56, radius 12, 1px divider border, background.paper.
- A 40×40 tile with radius 8, filled action.selected, icon `file` / `image` 20 in text.secondary.
- Name at 14px, meta at 12.5px in text.secondary.

**Plan 82, scheduled tasks** (`raditi-sched`):
- Row (`scheduled/schedule-row.tsx:88-150`):
  - A 40×40 tile with radius 12, filled action.hover, icon `timer` 20 (primary.main when the task is on).
  - Name at 16/600.
  - Schedule words in body2 text.secondary, followed by «· project».
  - State at 14px.
  - A switch and «⋯» on the right.
- «Новая запланированная задача» dialog: 640 wide, radius 14, divider border.
  - Golos title 20/600 and a text button «Вместо этого настроить в чате».
  - «Название» field, then «Что сделать агенту» as a soft field (radius 20, action.hover) holding a project picker.
  - «Когда запускать» / «Как часто» / «Время», then «Отмена» / «Создать» (`scheduled/schedule-texts.ts:119-169`).
- The rail item there is «Задачи» → `/scheduled` with icon `timer` (`application/application-rail.tsx:28` in that tree).

**Empty-state precedents** — three exist:
1. **«Страницы»** (`components/pages/pages-empty.tsx:21-211`):
   - Section max width 560, top margin 48 / 80, centred.
   - Illustration: a 168-wide browser card (divider border, radius 14, paper fill, three 6px dots, the address in mono 9.5px, a primary bar and divider bars).
   - Title h2 in Golos 22/26 600/1.3, 24px above it.
   - Lead at 15/16 in text.secondary, 10px above it.
   - Contained pill «Начать чат», 44 high, padding x 24, 24px above it.
   - Then a bordered list of example requests: radius 12, rows 48 high with an icon 18.
   - While the list is empty, the header button is hidden (`pages-view.tsx:236`).
2. **Old «Проекты»** (`origin/main:apps/web/src/components/projects/projects-illustration.tsx`):
   - A 168×132 line drawing, stroke 2.4, round caps, in text.primary.
   - The back window at 0.45 opacity, the front window filled with background.paper.
   - The Raditi asterisk `M140 14v20M131.3 19l17.4 10M131.3 29l17.4-10` stroked in primary.main at 2.8.
   - Title at 17/600, text at 14/1.55 with max width 430, button outlined inherit «Новый проект».
3. **Plan 82 stopwatch:** 112px, text.secondary marks, a paper dial with a divider rim, an orange hand that turns once (`raditi-sched:apps/web/src/components/scheduled/stopwatch-mark.tsx`).

### 1.8 Icons

- **AppIcon:** 24 viewBox, `stroke=currentColor`, `stroke-width 1.7`, round caps and joins, no fill, default size 20 (`application/app-icon.tsx:105-118`).
  - In use: 20 on the rail and in navigation, 18 in fields and menus, 16 in small rows, 13 in status marks.
- **Names:** projects, profile, pages, settings, plans, payment, usage, panel, paneHide, expand, results, logout, plus, search, microphone, pin, archive, sort, globe, arrow, chevron, down, download, close, back, send, check, clock, chat, changes, runs, database, more, lock, warning, slash, eye, file, document, forward, share, copy, contents, stop, terminal, folder, key, retry, attach, image, fullscreen, shrink, keyboard, pointer, pencil, trash, square, group, brain (`app-icon.tsx:3-91`).
- **Already taken:**
  - `brain` means «Размышление» (`effort-menu.tsx:80`) and also «Навыки агента» in settings (`account/settings-nav.ts:20`).
  - `clock` is the status of a running chat (`status-mark.tsx:14-20`).
  - `lock` is «Переменные».

### 1.9 Drift worth knowing

- `DESIGN.md:393` first describes the composer as "radius 22, frame rule-strong", then in the same paragraph as an action.hover fill without a border. The code is radius 28 with no border (`composer.tsx:655-673`); follow the code.
- The page-title font is split between Unbounded and Golos (§1.2). Dialog titles are split between MUI's Unbounded 17 and Golos 20.
- Leftover strings in `chat-texts.ts:368-380` («По проектам», «Без проекта», «Проект для этого чата», «Добавить проект») are unused after plan 83 and could be reused.

## 2. Mapping and new icons

| Purpose | Icon | Note |
| --- | --- | --- |
| «Проекты» (rail, project tile) | `projects` | Folder, `app-icon.tsx:4-5`. |
| «Инструкции» | `contents` (lines) | `pencil` for «Изменить». |
| «Контекст» (section) | new `layers` | Rows use `file`, `image` or `document`. |
| Add context | `attach` or `plus` | Consistent with the composer. |
| Upload | new `upload` | Mirror of `download`. |
| Text content | new `text` | Or `document`. |
| GitHub link | new `link` and new `github` | |
| GitLab account | new `gitlab` | |
| Pull repository | `folder` or new `branch` | `folder` already shows an arrow into a folder (`app-icon.tsx:67-68`). |
| Merge, merge request | new `merge`, new `pullRequest` | |
| CI/CD pipelines | `runs` | A checklist with ticks (`app-icon.tsx:43`); the pipeline state goes in status dots. |
| «Память» | new `memory` | Not `brain`. |
| «Запланировано» | `timer` | From plan 82, not `clock`. |
| Options, delete, close | `more`, `trash`, `close` | |

All new paths below use the same style (24 grid, stroke 1.7, round caps and joins). The `github`, `gitlab`, `branch`, `merge` and `pullRequest` paths are Lucide shapes (ISC licence, already used for `brain`). I wrote them from memory, and the brand ones are deprecated in Lucide, so check them against `lucide-static` before they go into code.

```
upload:      M12 20V9M7 14l5-5 5 5M5 4h14
text:        M5 7V5h14v2M12 5v14M9 19h6
link:        M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2
layers:      M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5
memory:      M7 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM5 19a2 2 0 0 1 2-2h12M9 7h6M9 10.5h4
timer:       M10 2h4M12 2v4M19.5 13.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0ZM12 13.5l3-3M18.5 7 20 5.5   (plan 82, raditi-sched app-icon.tsx:88-90)
branch:      M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9
merge:       M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21V9a9 9 0 0 0 9 9
pullRequest: M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13 6h3a2 2 0 0 1 2 2v7M6 9v12
github:      M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2
gitlab:      m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z
```

Empty-state illustration for «Хотите создать проект?», in the old-projects family (168×132, stroke 2.4, back shape at 0.45, front shape filled with the card colour, the asterisk in primary):

```html
<svg width="168" height="132" viewBox="0 0 168 132" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text)">
  <path opacity=".45" d="M60 16h38l14 14v40H54V22a6 6 0 0 1 6-6ZM98 16v14h14M66 32h20M66 42h30"/>
  <path fill="var(--card)" d="M26 50a6 6 0 0 1 6-6h26l8 8h64a6 6 0 0 1 6 6v50a6 6 0 0 1-6 6H32a6 6 0 0 1-6-6V50Z"/>
  <path d="M26 64h110M42 80h44M42 92h60"/>
  <path stroke="var(--primary)" stroke-width="2.8" d="M144 12v20M135.3 17l17.4 10M135.3 27l17.4-10"/>
</svg>
```

## 3. CSS variables for HTML boards

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400..900&family=Unbounded:wght@400..700&family=JetBrains+Mono:wght@400..600&display=swap">
<style>
:root{
  color-scheme:light;
  --font-body:"Golos Text","Segoe UI","Helvetica Neue",Arial,sans-serif;
  --font-heading:"Unbounded",Verdana,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --ground:#F3E7D5; --page:#FFF8EC; --card:#FFFCF5; --raised:#FFFCF5;
  --soft:rgba(36,23,16,.04); --selected:rgba(36,23,16,.08);       /* ≈#F6F3EC / ≈#EDEAE3 on card */
  --divider:#E1CDB6; --input-border:rgba(0,0,0,.23); --rule-strong:#8D7968;
  --text:#241710; --text-2:#695547; --text-3:rgba(36,23,16,.38);
  --primary:#A63D12; --on-primary:#FFFFFF; --focus:#A63D12;
  --accent:#FF6B24; --accent-hover:#FF8B30; --on-accent:#241710; --accent-edge:#A63D12;
  --marker:#FFC547; --accent-soft:#FFE1CC;
  --switch-on:#A63D12; --switch-on-track:rgba(166,61,18,.5); --switch-off:#FFFFFF; --switch-off-track:rgba(0,0,0,.38);
  --danger:#9C3D26; --warning:#92551E; --success:#79573B; --info:#A63D12;
  --dot-ok:#2E9F62; --dot-wait:#C77F0A; --dot-broken:#D9482B; --dot-off:#8C8072;
  --tooltip:rgba(97,97,97,.92); --on-tooltip:#FFFFFF; --backdrop:rgba(0,0,0,.5);
  --composer-ring:rgba(36,23,16,.24);
  --shadow-menu:0 5px 5px -3px rgba(0,0,0,.2),0 8px 10px 1px rgba(0,0,0,.14),0 3px 14px 2px rgba(0,0,0,.12);
  --shadow-dialog:0 11px 15px -7px rgba(0,0,0,.2),0 24px 38px 3px rgba(0,0,0,.14),0 9px 46px 8px rgba(0,0,0,.12);
  --shadow-popover:0 8px 24px -12px rgba(0,0,0,.18);
  --r-card:18px; --r-surface:14px; --r-tile:12px; --r-row:10px; --r-icon-tile:8px;
  --r-composer:28px; --r-soft-field:20px; --r-pill:999px; --r-rail-item:14px;
  --rail:72px; --rail-phone:56px; --panel:284px; --gap:10px; --toolbar:64px; --hit:44px;
  --ease-out:cubic-bezier(.16,1,.3,1); --ease-in-out:cubic-bezier(.65,0,.35,1);
  --t-press:90ms; --t-fast:160ms; --t-base:240ms;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --ground:#241710; --page:#241710; --card:#352217; --raised:#352217;
  --soft:rgba(255,241,222,.08); --selected:rgba(255,241,222,.16);  /* ≈#453327 / ≈#554337 on card */
  --divider:#5A3C28; --input-border:rgba(255,255,255,.23); --rule-strong:#5A3C28; /* no strong rule in dark */
  --text:#FFF1DE; --text-2:#C6AE95; --text-3:rgba(255,241,222,.38);
  --primary:#FFB86B; --on-primary:#241710; --focus:#FFB86B;
  --accent-soft:rgba(255,241,222,.16);                              /* accentSoft has no dark value */
  --switch-on:#FFB86B; --switch-on-track:rgba(255,184,107,.5); --switch-off:#E0E0E0; --switch-off-track:rgba(255,255,255,.3);
  --danger:#F09B7C; --warning:#E6BA7E; --success:#D6B495; --info:#FFB86B;
  --composer-ring:rgba(255,241,222,.24);
}
@media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){
  color-scheme:dark;
  --ground:#241710; --page:#241710; --card:#352217; --raised:#352217;
  --soft:rgba(255,241,222,.08); --selected:rgba(255,241,222,.16);
  --divider:#5A3C28; --input-border:rgba(255,255,255,.23); --rule-strong:#5A3C28;
  --text:#FFF1DE; --text-2:#C6AE95; --text-3:rgba(255,241,222,.38);
  --primary:#FFB86B; --on-primary:#241710; --focus:#FFB86B;
  --accent-soft:rgba(255,241,222,.16);
  --switch-on:#FFB86B; --switch-on-track:rgba(255,184,107,.5); --switch-off:#E0E0E0; --switch-off-track:rgba(255,255,255,.3);
  --danger:#F09B7C; --warning:#E6BA7E; --success:#D6B495; --info:#FFB86B;
  --composer-ring:rgba(255,241,222,.24);
}}
body{background:var(--ground);color:var(--text);font:16px/1.5 var(--font-body)}
</style>
```

## 4. Implications for Raditi projects

1. **Not Claude's grey.** The canvas is cream on light, chocolate on dark. Cards are `--card` on `--ground`, joined by a 10px gap and an 18px radius. The one bright colour is the accent pill with ink text (`#FF6B24` / `#241710`). Small accents use `--primary`. Do not invent a raised tone in dark: menus and dialogs are `#352217` with a border and a shadow.
2. **Frame.** Both «Проекты» and a project page fit `ApplicationShell`: the rail plus one content card, no panel, no toolbar (as `/pages`, `app/(protected)/pages/page.tsx:19`). The content is max 1200 wide with the padding listed in §1.4.
   - The rail keeps «Чаты», «Страницы», «Проекты». Plan 82 adds «Задачи»; whether it stays is question 6.
   - Today the rail's «Проекты» link points to a route that does not exist (§1.7).
3. **Empty list.**
   - Header: «Проекты» on the left; the «Новый проект» button is hidden while the list is empty, as on «Страницы».
   - Centred block: the 168×132 illustration from §2, «Хотите создать проект?» in Golos 22/26 600, a lead at 15/16 in `--text-2` with max width 480, and a contained accent pill «Новый проект» 44 high with `plus` 18.
4. **Project list with items.**
   - Header: title plus a contained «Новый проект» 40 high.
   - Grid: 1 / 2 / 3 columns at xs / md / lg, 20px gaps.
   - Each project card: `--card` with a 1px divider border, radius 14, padding 20–24; the `projects` icon 24; name at 19/600; description at 14 in `--text-2`; a divider and caption meta («N чатов · обновлён …»).
5. **«Новый проект» modal.**
   - Dialog about 600 wide, radius 14, 1px divider border, padding 24, dialog shadow; full screen on a phone.
   - Title in Golos 20/600.
   - Fields:
     - «Над чем вы работаете?» as an outlined TextField (56, radius 14).
     - «Чего вы хотите достичь?» as an outlined multiline field (3–6 rows).
     - «Контекст — необязательно» as a body2/500 label over a soft drop area (`--soft`, radius 20; inset 2px accent while dragging), holding an outlined pill «Добавить контекст» with `attach` 18 and the file chips.
   - Actions on the right: text «Отмена», then contained «Создать проект».
6. **Project page from 1200px: two columns inside the content card.**
   - **Left column** (max 760):
     - a «Все проекты» back link, 14px with `back`
     - the title, then the description in `--text-2`
     - the composer exactly as in chats (112px collapsed); placeholder «Что нужно сделать?» or a «Новый чат в проекте «X»» variant
     - «Чаты проекта» rows in the chat-list anatomy
   - **Right column** (about 340): stacked surfaces (`--card`, divider border, radius 14, padding 20, 12px apart). Each section has a 16/600 title, a section icon of 18 in `--text-2`, and a 44 «+» or `pencil` button on the right.
     - «Инструкции»: shows the text clamped to 4 lines; editing is an inline textarea (radius 12) with «Сохранить» and an «N из M» counter.
     - «Контекст»: file chips (56, radius 12, 40 icon tile), text snippets (`text`), a GitHub link row (`link` + `github`), and «Подключить GitLab» as an outlined pill with `gitlab`. Once connected:
       - a repository row with a `branch` chip
       - a «Пайплайны» list: a `runs` icon, the pipeline name, a status dot (`--dot-*`) with its word, and the time as a caption
       - «Слить» (`merge`) and «Настроить CI» as secondary actions
     - «Память»: body2 `--text-2` «Память пока пуста. Память проекта появится здесь после нескольких сессий», then a switch row «Использовать память аккаунта» with a hint.
     - «Запланировано»: plan 82 rows (40 `timer` tile, name 16/600, schedule words, switch, «⋯»). «+» opens the plan 82 dialog «Новая запланированная задача» (640, radius 14).
   - **Below 1200px** the right column moves under the composer. **On a phone** the sections become 48px rows that open sheets, and the card frame disappears (no cards below 900px).
7. **Interaction states on every board.**
   - Hover: `--soft`. Selected: `--selected`, and the text on a selected row switches to `--text` in dark.
   - Focus: a 2px `--focus` ring with offset 3 (offset 2 inside rows).
   - Disabled: `--text-3`.
   - Errors: body2 in `--danger`.
   - No tooltip-only meaning; every hit area at least 44.

## 5. Questions for the owner (each with a proposed default)

1. **Page-title font for «Проекты» and the project name:** Unbounded like «Страницы», or Golos 28/32 per `DESIGN.md:224`? **Default:** Unbounded 30 (26 on a phone), so the rail's sister pages match. Inside the project the name is Golos 28/600.
2. **Claude says «Новая сессия в проекте X»; Raditi says «чат».** **Default:** placeholder «Что нужно сделать?» with a caption above the field «Новый чат в проекте «X»»; the word «сессия» is not used.
3. **«+» in the composer as in Claude, or keep «/», paperclip and «Размышление»?** The owner chose the paperclip on 29.10.2026; the «Плюс в поле чата» canvas is pending. **Default:** keep the current composer; the boards show «+» only if that canvas gets approved.
4. **The right settings column:** a column inside the content card, or a separate fixed card at the right edge like the tools pane (`chat/pane-layout.ts:7`, 440–760 wide)? **Default:** a 340px column inside the content card from 1200px, stacked under the composer below that. This keeps the tools pane free for the chat itself.
5. **Icon for «Память»:** `brain` already means «Размышление» and «Навыки агента». **Default:** the new `memory` notebook icon from §2.
6. **«Запланировано» scope:** only inside a project, or also the global «Задачи» rail item from plan 82? **Default:** keep both, with the project section showing that project's tasks, and use `timer` everywhere.
7. **GitHub and GitLab marks:** monochrome line icons, or official colour logos? **Default:** monochrome in `currentColor` and stroke 1.7, everywhere.
8. **Dark menus and dialogs:** keep them the same tone as cards (`#352217`, as the code does), or lift them lighter? **Default:** keep the code: same tone, plus a divider border and a shadow.
9. **Modal width and phone behaviour:** **Default:** 600 wide with a divider border; full screen below 600px, as plan 82's dialog does.
10. **Dialog title style:** Golos 20/600, as ConfirmDialog and ScheduleDialog do, or MUI's Unbounded 17? **Default:** Golos 20/600 for all new dialogs.
11. **Empty-state illustration style:** **Default:** the line drawing of the old projects page (stroke 2.4, the asterisk in primary), shown in §2. The alternative is a card mock like «Страницы».
