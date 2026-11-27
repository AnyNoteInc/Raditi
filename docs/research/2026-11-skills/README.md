# Навыки агента: исследование и спайк Н0 (27.11.2026)

К [плану 97](../../plan/97-skills.md).

## Источники

- Стандарт: agentskills.io/specification.
- Claude Code: code.claude.com/docs/en/skills, …/plugin-marketplaces; github.com/anthropics/skills.
- Codex: learn.chatgpt.com/docs/build-skills; github.com/openai/codex (`codex-rs/skills`, `codex-rs/core-plugins/src/marketplace.rs`); github.com/openai/skills.
- OpenCode 1.18.34 (закреплённая версия): github.com/anomalyco/opencode, тег `v1.18.34`, `packages/opencode/src/skill/index.ts`, `src/session/system.ts`, `src/session/prompt.ts`.
- skills.sh: github.com/vercel-labs/skills.

Сводка по трём агентам — §1 плана 97.

## Спайк Н0: поиск навыков в OpenCode 1.18.34

**Как проверяли.** Образ песочницы `raditi-browser-task-verify/sandbox:local` с OpenCode 1.18.34, без сети, пользователь 10001. Окружение CLI — как у драйвера: `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_PURE=1`.

В `~/.config/opencode/opencode.json` заданы:

- `skills.paths`: `/workspace/skills` и `/usr/local/lib/raditi/skills`;
- `permission.skill`: `{ "*": "deny", "demo": "allow", "skill-creator": "allow" }`.

**Что лежало:**

- наши навыки: `/workspace/skills/demo` и `/workspace/skills/userly`;
- встроенные: `infra/sandbox/skills` в `/usr/local/lib/raditi/skills`;
- «чужие» навыки во всех местах, где их ищет OpenCode:
  - в репозитории — `.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`, а также `opencode.json` со своими `skills.paths`;
  - в домашней папке — `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skills`.

Команда — `opencode debug skill` в `/workspace/repo`.

**Итог:**

| Навык | Загружен | Почему |
| --- | --- | --- |
| `demo`, `userly` (`/workspace/skills`) | да | `skills.paths` |
| `skill-creator`, `commercial-offer`, `product-cards`, `social-posts` | да | `skills.paths`; описание в кавычках YAML разобрано |
| `customize-opencode` | да, встроен в CLI | скрыт правилом `'*': 'deny'`: навык с `deny` не попадает в `<available_skills>` (`Skill.available` фильтрует по `Permission.evaluate`) |
| навыки и `opencode.json` репозитория | нет | `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` |
| `~/.claude/skills`, `~/.agents/skills` | нет | `OPENCODE_DISABLE_EXTERNAL_SKILLS` |
| `~/.config/opencode/skills` | да | папка конфигурации CLI сканируется всегда. В ходе она недостижима: обёртка (`opencode-wrapper.ts`, `only`) отказывает при любом файле там, кроме `AGENTS.md` и `opencode.json`, и закрывает папку на запись до запуска CLI |

`opencode debug skill` показывает все найденные навыки, без фильтра прав. Фильтр по `permission.skill` применяется, когда собирается системный промпт агента (`session/system.ts` → `skill.available(agent)`), и в инструменте `skill`. Проверено по исходникам `v1.18.34`.

Вывод: решения Нв13–Нв15 держатся на CLI как он есть.
