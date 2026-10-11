# Источники форматов

В пакете один драйвер — OpenCode. Парсеры и примеры вывода прежних оболочек удалены вместе с их драйверами в G8 (`docs/plan/48-removal.md`).

`opencode.jsonl` — минимальный, обезличенный пример протокола: идентификаторы, команды, текст и счётчики заменены на тестовые; это не запись запуска модели в Радити. Первая версия собрана 26.09.2026 по исходному коду релиза, затем сверена с исполнением закреплённого CLI.

| CLI | Релиз и источник JSONL |
| --- | --- |
| OpenCode | `v1.18.32`, `545f51d26cc39a907d2867492d498d9607ea5fa4`: [run и emit](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/cli/cmd/run.ts), [схемы частей](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/schema/src/v1/session.ts), [getUsage](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts) |

Что сохраняется для продолжения: [путь SQLite](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/database/database.ts), [XDG paths](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/global.ts). Только `opencode.db` и его WAL для stable release с HOME под `/agent-home/opencode`, после остановки CLI. `auth.json`, config, log, repos и snapshot не входят. Продолжение в новом контейнере только из этих двух файлов подтверждено в G3 на закреплённом 1.18.34 (абзац ниже).

OpenCode 1.18.34 (G3, 09.10.2026). `prepare` и `command` драйвера реализованы, а формат сверен с исполнением закреплённого CLI, а не с исходниками 1.18.32.

- `opencode.jsonl` — тот же минимальный ход, но в форме строк 1.18.34: у частей есть `messageID` и `sessionID`, у `step-finish` — `tokens.total`, вызовы `write` и MCP-инструмента идут отдельными строками `tool_use`.
- `opencode-turns.json` — десять ходов, записанных настоящим CLI в разведке G1 и очищенных `infra/dev/llm-verify/sanitize-samples.mjs` (источник — `docs/research/2026-10-opencode-glm/samples/72-g1-refusals/events/` и `74-g1-config/`): сжатие контекста, отклонённый запрос разрешения, отказы 403 и внутри потока, отказ после шага с инструментом, исчерпанные повторы, переполнение контекста, `finish_reason` `content_filter`, `length` и неизвестный. Тексты и идентификаторы заменены, ключей в записях нет.
- Строки конца хода CLI не печатает. `step_finish` с `reason: "stop"` даёт `completed`, но итог у хода есть, только если вывод кончается шагом ответа: `started`, собственный текст шага, `completed` — и ничего после (`extractOpencodeResult` в `opencode.ts`). Шаг с `reason` `length`, `content-filter`, `unknown` и любым другим, кроме `stop` и `tool-calls`, — `failed`.
- В снимок идут те же два файла — `opencode.db` и его WAL. Следующий ход их не использует как есть: обёртка драйвера читает базу командой `opencode export`, собирает файл импорта заново из девяти полей строки сессии и сообщений, удаляет базу и создаёт новую командой `opencode import` ([отчёт G3](../../../../docs/plan/42-opencode-driver.md)).

Ограничения адаптации:

- Парсер stateless: экземпляр реестра может обслуживать несколько задач. Частичные события, reasoning и произвольный вывод инструментов не попадают в клиентские сообщения. Неподтверждённый успех инструмента не выдумывается.
- `tokens.input` уже исключает кэш, а `tokens.output` исключает reasoning: в общий `output` reasoning добавляется один раз. Несогласованные счётчики отбрасываются. Суммы `cost` игнорируются; ни один stdout-счётчик не используется для биллинга.
- `capabilities` описывает возможности CLI. Полный запуск и resume проверяют стенды драйвера (`pnpm verify:opencode`, `pnpm verify:opencode-supervisor`), эти фикстуры их не проверяют.
- Результат извлекается только из последнего сообщения или явно переданного last-message файла. Допустим JSON-объект либо один JSON code fence; нужен `turnResultSchema`. Произвольный текст, старый успешный объект перед ошибкой, несколько блоков и невалидный итог дают `null`.
