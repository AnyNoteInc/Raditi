# Проверка P1: драйверы и снимки ходов

26.09.2026. P1 реализует разбор вывода CLI и хранение состояния между ходами.
Полный запуск агента с моделью, Docker-провайдер и жизненный цикл задачи ещё не реализованы.

## Что работает

- `packages/agent-drivers`: stateless JSONL-парсеры Codex, Kimi, Qwen, OpenCode;
  общие события проходят zod, итог — `turnResultSchema`. Fixtures синтетические,
  составлены по закреплённым upstream-исходникам; [версии и ссылки](../../packages/agent-drivers/src/fixtures/README.md).
- `sessionState`: буквальные списки файлов native session, без настроек авторизации,
  логов и бинарников. Kimi и Qwen требуют безопасный `nativeSessionId` выбранной сессии.
- `packages/domain`: строгий манифест v1, фиксированные пути, ограничения размера,
  идентификаторов и образа по digest. Секреты хода запрещены под `/workspace` и `/agent-home`.
- `apps/orchestrator/src/sessions`: capture/restore через `Sandbox.exec`, проверка
  USTAR/Zstd на хосте, AES-256-GCM, immutable reservation, запись манифеста последней.
  Хост не извлекает архивы на свою файловую систему; patch возвращается как данные.
- `packages/storage`: атомарный `putIfAbsent`; `packages/vault`: Transit datakey/decrypt
  и AppRole login. Ключ данных не передаётся песочнице и обнуляется после использования.

Тесты проверяют round trip, конкурентную и повторную запись, неоднозначный ответ S3,
подмену шифротекста и метаданных, чужое workspace, несовместимый образ/драйвер,
изменение входных буферов во время await, утечки ключа, архивные бомбы,
traversal, ссылки, дубликаты и повреждённые заголовки. Ни один отказ в проверке архивов
не запускает запись в песочницу. Проверяются лимиты exec, оффсеты вывода, таймауты и kill.

## Воспроизводимая проверка S3 + Transit

Нужны Node 26.10, pnpm 12.6, `.env` из bootstrap и работающий Docker.

```sh
nvm use
pnpm install --frozen-lockfile
docker compose --env-file .env -f infra/dev/docker-compose.yml up -d --pull never s3 s3-init vault
pnpm --filter orchestrator verify:snapshots
```

Команда собирает orchestrator и работает только с loopback-адресами S3 и OpenBao,
используя локальный dev token. Она создаёт Transit mount, если его ещё нет,
и уникальный ключ `ws-p1verify-<uuid>`. Проверяются 12 конкурентных conditional PUT,
сохранение трёх зашифрованных частей, побайтная загрузка, отказ повторной записи
и отказ чужому workspace. Свои S3-объекты и Transit-ключ удаляются в `finally`;
существующие данные, mount и ключи других рабочих пространств не удаляются.
Модели не вызываются. Проверка пройдена на SeaweedFS 4.47 и OpenBao 2.7.0.

```sh
pnpm gates
pnpm format:check
docker compose --env-file .env -f infra/dev/docker-compose.yml stop s3 s3-init vault
```

Интеграционные тесты базы без `DATABASE_URL` пропускаются; P1 схему БД не меняет.
Новых переменных окружения и миграций нет. GitHub Actions подтверждаются после push.

Итог локального прогона: `pnpm gates` прошёл (check-env, typecheck, lint,
check-architecture, test, build), **1250 тестов passed, 41 тест БД skipped**.
`pnpm format:check` и `git diff --check` прошли. В orchestrator — 92 теста
непосредственно на архивы, exec-перенос и сохранение/загрузку; в agent-drivers — 100.
Независимый review нашёл и помог закрыть усечение итогового JSON и расхождение
парсеров tar-stream/GNU tar на повреждённых числовых полях. Spec-check выполнен.

## Перенос между настоящими контейнерами

Сценарий `verify:transport` проверен в двух одноразовых контейнерах Ubuntu 24.04
с GNU tar 1.35, git 2.43.0 и zstd 1.5.5. Файловая система только для чтения,
данные в tmpfs, uid 10001, сеть отключена; bind mounts и `docker cp` не используются.
Git-репозиторий и native session синтетические. При сборке проверочного образа
нужен доступ к Ubuntu apt-репозиторию; исполняемые контейнеры сети не имеют.

```sh
docker build --pull=false -t raditi-snapshot-fixture:local \
  -f apps/orchestrator/scripts/snapshot-fixture.Dockerfile apps/orchestrator/scripts
pnpm --filter orchestrator verify:transport \
  "$(docker image inspect raditi-snapshot-fixture:local --format '{{.Id}}')"
docker image rm raditi-snapshot-fixture:local
```

Проверены точные байты home и трёх untracked-файлов (Unicode, бинарные и пустые),
исключение auth/config/gitignored, существующие каталоги назначения, отказ повторного
restore с сохранением изменённого файла и отказ при абсолютном симлинке до tar.
Tracked-файлы при restore остаются на базе; отдельный `git apply` на синтетических
данных подтверждает сохранность binary/text/delete patch. Совпадают HEAD, diff и status.
Сценарий поймал несовместимость `--keep-old-files` с `--no-overwrite-dir` у GNU tar;
несовместимый флаг удалён. Runtime-контейнеры удаляются в `finally`.
Это проверочный адаптер exec; изоляцию gVisor и полный `SandboxProvider` проверит P2.

## Ограничения и следующий шаг

- P1 использует ограниченный буфер в памяти: архив до 16 МиБ, patch до 8 МиБ,
  распакованный архив до 128 МиБ, файл до 32 МиБ, до 10 000 записей.
  PAX/GNU-расширения имён не принимаются; пути должны представляться в USTAR.
  Полный контракт и шифрование описаны в spec §8/14/15.
- Restore требует новый контейнер без процессов агента и clone предыдущего `headSha`.
  Контейнеры, аренды, выдача секретов после восстановления, публикация patch,
  сборка образов с GNU tar/zstd/git и разбор незавершённых reservation — P2.
- `prepare` и `command` CLI остаются заглушками P4/P5. `capabilities` — свойства CLI,
  а не готовность runtime. Парсеры не доказывают, что модель успешно выполнила ход;
  супервизор обязан проверить exit code и финальный результат.
- Runtime не создаёт Transit-ключи рабочих пространств. Provisioning mount/keys,
  политики, KV v2, SSH CA и wrapping — P7.
