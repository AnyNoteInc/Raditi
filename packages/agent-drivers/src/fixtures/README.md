# Источники форматов P1

Проверено 26.09.2026 по исходному коду релизов. JSONL-файлы — минимальные,
обезличенные примеры реального протокола, собранные по перечисленным ниже
сериализаторам и upstream-тестам. Идентификаторы, команды, текст и счётчики заменены
на тестовые; это не записи запуска модели в Радити. Модели для P1 не запускались.
Локальный `codex --version` показал 0.154.0; парсер проверен по исходникам 0.157.1.

| CLI | Релиз и источник JSONL |
| --- | --- |
| Codex | `rust-v0.157.1`, `36650394c5b38c2990ccf2a3457165ca3e9d9726`: [схемы событий](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/exec/src/exec_events.rs), [тесты преобразования](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/exec/tests/event_processor_with_json_output.rs), [режим JSONL](https://learn.chatgpt.com/docs/non-interactive-mode) |
| Kimi | `@moonshot-ai/kimi-code@2.1.1`, `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`: [PromptJsonWriter](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/kimi-code/src/cli/prompt-render.ts), [print runner](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/apps/kimi-code/src/cli/v2/run-v2-print.ts), [Bash](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts), [AskUserQuestion](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/agent/tools/ask-user-question/askUserQuestionTool.ts) |
| Qwen | `v0.24.6`, `753bd075a24ca886b7d0119ca53d97bd65c09e4a`: [BaseJsonOutputAdapter](https://github.com/QwenLM/qwen-code/blob/753bd075a24ca886b7d0119ca53d97bd65c09e4a/packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts), [тесты stream-json](https://github.com/QwenLM/qwen-code/blob/753bd075a24ca886b7d0119ca53d97bd65c09e4a/packages/cli/src/nonInteractive/io/StreamJsonOutputAdapter.test.ts) |
| OpenCode | `v1.18.32`, `545f51d26cc39a907d2867492d498d9607ea5fa4`: [run и emit](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/cli/cmd/run.ts), [схемы частей](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/schema/src/v1/session.ts), [getUsage](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/opencode/src/session/session.ts) |

Что сохраняется для продолжения:

- Codex: только `sessions/`; конфигурация, `auth.json`, логи и база интерфейса не входят.
- Kimi: [расположение данных](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/docs/en/configuration/data-locations.md), [ключ рабочего каталога](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/_base/utils/workdir-slug.ts). В снимок входят `session_index.jsonl`, `state.json` выбранной сессии и её `agents/`. В 2.1.1 `session.resume_hint` уже передаёт native id на stdout. До `sessionState` этот id нужно записать в `run.context.nativeSessionId`.
- Qwen: [chatRecordingService](https://github.com/QwenLM/qwen-code/blob/753bd075a24ca886b7d0119ca53d97bd65c09e4a/packages/core/src/services/chatRecordingService.ts), [storage](https://github.com/QwenLM/qwen-code/blob/753bd075a24ca886b7d0119ca53d97bd65c09e4a/packages/core/src/config/storage.ts), [sanitizeCwd](https://github.com/QwenLM/qwen-code/blob/753bd075a24ca886b7d0119ca53d97bd65c09e4a/packages/core/src/utils/paths.ts). Только `.qwen/projects/-workspace-repo/chats/<nativeSessionId>.jsonl`. Runtime-файлы процессов, другие сессии и настройки не входят.
- OpenCode: [путь SQLite](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/database/database.ts), [XDG paths](https://github.com/anomalyco/opencode/blob/545f51d26cc39a907d2867492d498d9607ea5fa4/packages/core/src/global.ts). Только `opencode.db` и его WAL для stable release с HOME под `/agent-home/opencode`, после остановки CLI. `auth.json`, config, log, repos и snapshot не входят. Подтверждение resume в новом контейнере остаётся P5.

Ограничения адаптации:

- Парсеры stateless: экземпляры реестра могут обслуживать несколько задач. Частичные события, reasoning и произвольный вывод инструментов не попадают в клиентские сообщения. У Kimi/Qwen tool-result не содержит имени инструмента; сопоставление с предыдущими вызовами потребует отдельного контекста на запуск в P5. Неподтверждённый успех инструмента не выдумывается.
- Kimi stream-json не передаёт usage и финальный terminal event. Завершение подтверждается exit code процесса в P5; последний текст сам по себе не доказывает успешное выполнение.
- Qwen usage: `input_tokens` получен из `promptTokenCount`, кэш вычитается. Несогласованные счётчики отбрасываются. OpenCode `tokens.input` уже исключает кэш, а `tokens.output` исключает reasoning: в общий `output` reasoning добавляется один раз. Суммы `cost` игнорируются; ни один stdout-счётчик не используется для биллинга.
- `capabilities` описывает возможности CLI. В P1 готовы разбор вывода, извлечение результата и выбор файлов; `prepare` и `command` остаются `NOT_IMPLEMENTED` до P4/P5. Полный запуск и resume здесь не проверены.
- Результат извлекается только из последнего сообщения или явно переданного last-message файла. Допустим JSON-объект либо один JSON code fence; нужен `turnResultSchema`. Произвольный текст, старый успешный объект перед ошибкой, несколько блоков и невалидный итог дают `null`.
