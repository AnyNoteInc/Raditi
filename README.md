# Радити

AI-поддержка сайтов малого бизнеса: владелец пишет в чат — агент меняет сайт. Домен — raditi.ru.

В этом архиве — всё, чтобы начать разработку с Claude Code: инструкции для агента (`CLAUDE.md`, `.claude/`), спецификация и бизнес-модель (`docs/`), план работ и локальная инфраструктура (`infra/dev`). Кода приложения пока нет — его собирает команда `/bootstrap`.

## Что внутри

```
CLAUDE.md                    главные правила проекта для Claude Code
.claude/settings.json        разрешения: pnpm, docker compose, чтение ../AnyNote
.claude/commands/            /bootstrap, /task, /spec-check
.claude/agents/              spec-reviewer, anynote-scout
docs/spec.md                 спецификация v0.2
docs/business.md             рынок, тарифы, юнит-экономика
docs/plan/roadmap.md         этапы, гейты, задачи с ID
docs/plan/00-bootstrap.md    первый шаг: каркас монорепозитория
docs/landing/                прототип лендинга
docs/model/                  модель юнит-экономики (xlsx)
infra/dev/                   docker compose для локальной разработки
.env.example                 переменные окружения
```

## Как начать

1. Распакуйте архив рядом с AnyNote — например, в `~/Projects/raditi`. Команды и агенты ждут образец в `../AnyNote`; если он в другом месте, поправьте путь в `.claude/settings.json` и `CLAUDE.md`.
2. Инициализируйте репозиторий:
   ```bash
   cd ~/Projects/raditi
   git init && git add . && git commit -m "chore: project brief for Claude Code"
   cp .env.example .env
   ```
3. Поднимите инфраструктуру (нужен Docker: Docker Desktop, OrbStack или Colima):
   ```bash
   docker compose --env-file .env -f infra/dev/docker-compose.yml up -d
   ```
   Gitea — http://localhost:3300 (администратора создайте командой ниже), OpenBao — http://localhost:8200, S3 — http://localhost:8333.
   ```bash
   docker compose -f infra/dev/docker-compose.yml exec gitea \
     gitea admin user create --admin --username raditi --password 'change-me-please' --email admin@raditi.local
   ```
4. Запустите Claude Code в папке проекта и выполните первую команду:
   ```bash
   claude
   > /bootstrap
   ```
5. Дальше — по задачам: `/task P1`, `/task P2`… или просто `/task`, чтобы взять следующую из `docs/plan/roadmap.md`.

Личные заметки для Claude Code (пути, токены тестовых сервисов) кладите в `CLAUDE.local.md` — он в `.gitignore`.

## Полезно знать

- gVisor на macOS не запускается: локально песочница работает с `SANDBOX_RUNTIME=runc`, изоляцию проверяйте в Linux-ВМ.
- Для S3 локально — SeaweedFS, а не MinIO: MinIO Community больше не развивается как открытый проект (spec §14).
- Ключи Yandex AI Studio и Cloud.ru нужны для LiteLLM (`--profile llm`) и задач P3–P5; ID моделей в `infra/dev/litellm.config.yaml` сверьте с каталогами провайдеров.
