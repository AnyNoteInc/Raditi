# Проверка доверенной публикации P2

`GitWorkspaceService` получает репозиторий и короткие credentials через `GitProvider`.
Реализация HTTP API провайдеров остаётся в P8. Production transport разрешает только HTTPS
origins из конфигурации; local transport доступен явно и только при `NODE_ENV=test`.
Credentials живут 5–125 секунд, передаются Git через `--config-env`, не попадают в URL,
аргументы с их значениями, конфигурацию клона, bundle или песочницу. Исходный клон делается
без checkout, хуков, сабмодулей, внешних credential helpers и перенаправлений HTTP.

Патч применяется к доверенному `expectedBaseSha`. Отдельно проверяются numstat, summary,
итоговый index, CI/CMS-пути и типы файлов. Повторные пути и copy/rename headers запрещены;
capture использует `--no-renames`, поэтому обычное переименование представлено удалением
и добавлением. Новые файлы читаются из проверенного архива как blob без извлечения на хост.
Перед native apply ограничиваются размеры binary literal/delta и существующих historical
postimage объектов. Каждый изменённый итоговый blob проходит Gitleaks с конфигурацией хоста,
без `gitleaks:allow` и без настроек из репозитория.

Лимиты: patch 8 МиБ, blob 32 МиБ, итоговое дерево 128 МиБ, до 10 000 файлов, bundle для
передачи в Docker 64 МиБ. Каждая внешняя команда ограничена 60 секундами. SHA-256 Git
repositories пока не поддерживаются: публикация явно принимает 40-символьный SHA-1.
Дедлайн исполняет отдельный Node supervisor: при остановке таймеров ядра он продолжает
работать, а при разрыве IPC немедленно убивает process group команды. Значение дедлайна
абсолютное и монотонное, поэтому запуск supervisor не продлевает разрешённое время.

`preparePublication` создаёт детерминированный commit (bot identity, task/turn, сохранённое
время). Возвращаются полный patch, candidate SHA и пустой untracked archive. Супервизор
сначала сохраняет checkpoint, затем удаляет контейнер и вызывает `publish(assertFence)`.
Push использует точный `--force-with-lease`; уже опубликованный candidate считается успехом.
Остановка Git-клиента не отменяет уже принятую сервером операцию: после неоднозначного
исхода повторная публикация сверяет remote ref. Атомарной транзакции между БД и Git нет.
`dispose()` закрывает доступ к кандидату и удаляет временный клон после текущего push.

## Повторяемый интеграционный smoke

Нужны Node 26.10, локальный Docker, Git и официальный Gitleaks **8.30.1**. Скрипт создаёт
только синтетические данные, временный локальный bare repository и контейнер через настоящий
`createDockerSandboxProvider`, без сети, с read-only rootfs и uid 10001. Он проверяет runtime
ready, checkout через stdin bundle, собственный commit
агента, quiesce и capture от доверенного base, удаление контейнера перед push, детерминированный retry
и блокировку синтетического токена настоящим Gitleaks. Все созданные ресурсы удаляются.
Внешние Git-серверы, модели, S3, Vault и основная БД не используются.

Официальные артефакты: [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1),
[checksums](https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt).
Пример для macOS arm64, из корня репозитория:

```sh
raditiVerifyDir="$(mktemp -d /tmp/raditi-gitleaks-verify.XXXXXX)"
curl --fail --silent --show-error --location \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz \
  -o "$raditiVerifyDir/gitleaks.tar.gz"
printf '%s  %s\n' b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 \
  "$raditiVerifyDir/gitleaks.tar.gz" | shasum -a 256 -c -
tar -xzf "$raditiVerifyDir/gitleaks.tar.gz" -C "$raditiVerifyDir" gitleaks
docker build --target runtime -f infra/sandbox/Dockerfile -t raditi-sandbox-runtime:p2 .
pnpm --filter orchestrator build
NODE_ENV=test \
P2_GITLEAKS_BINARY="$raditiVerifyDir/gitleaks" \
P2_SANDBOX_IMAGE="$(docker image inspect raditi-sandbox-runtime:p2 --format '{{index .RepoDigests 0}}')" \
node apps/orchestrator/scripts/verify-publication.mjs
```

Для Linux нужен соответствующий официальный архив и его checksum. `P2_SANDBOX_IMAGE`
принимает repository digest, без mutable tag и без image ID. Образ должен уже иметь `RepoDigests`
(сборка через Docker Engine с containerd image store либо push в локальный registry); скрипт
не создаёт фиктивный digest и не выполняет pull. Тестовый Gitleaks бинарник
можно удалить после проверки. Глобальная установка не требуется.

Проверено на macOS arm64: архив SHA-256 `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`,
распакованный бинарник SHA-256 `ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f`.
Smoke не подтверждает P8 HTTPS credentials API, реальный push в Gitea или Linux/runsc networking.
