# Проверка доверенной публикации P2

`GitWorkspaceService` получает репозиторий и короткие credentials через `GitProvider`.
Для Gitea два нужных ходу метода (`getRepository`, `issueCredentials`) реализованы в N4, остальные
методы и другие провайдеры остаются в P8. Production transport разрешает только HTTPS
origins из конфигурации; local transport доступен явно и только при `NODE_ENV=test`.
Credentials живут 5–125 секунд, передаются Git через `--config-env`, не попадают в URL,
аргументы с их значениями, конфигурацию клона, bundle или песочницу. Исходный клон делается
без checkout, хуков, сабмодулей, внешних credential helpers и перенаправлений HTTP.

Свой CA сервера git задаёт `transport.caFile` (`GIT_CA_FILE`): абсолютный путь к существующему
файлу проверяется в конструкторе и передаётся Git как `GIT_SSL_CAINFO`. Это ещё один доверенный
CA, а не замена: в образе orchestrator (Debian, libcurl-gnutls) системный набор CA остаётся
доверенным. Проверка сертификата не отключается. `readBranchHead({ repo, branch })` читает голову
ветки одним `ls-remote` с доступом на чтение, без клона; отсутствующая ветка — `null`.
`GitWorkspaceModule` даёт `GIT_PROVIDER` и `GitWorkspaceService` из `CoreConfig.git`; пока git
не настроен (нет `GITEA_URL` либо адрес `http:` вне production), оба — `null`.
`GitCredentialRuntime` того же модуля при старте `core` просит провайдера удалить просроченные
доступы прошлых процессов (`sweepCredentials`, не ждёт ответа, при `background: false` не
вызывается), а при остановке — удалить доступы, выданные этим процессом (`revokeCredentials`,
в `onApplicationShutdown`). Сбой любого из двух — строка `warn` без текста ошибки; старту и
остановке он не мешает.
Настоящую Gitea 1.27.3 по HTTPS проверяет `pnpm verify:gitea`
([стенд](../../../../infra/dev/gitea-verify/README.md), [отчёт](../../../../docs/plan/32-gitea-turn-git.md)).

Патч применяется к доверенному `expectedBaseSha`. Отдельно проверяются numstat, summary,
итоговый index, CI/CMS-пути и типы файлов. Повторные пути и copy/rename headers запрещены;
capture использует `--no-renames`, поэтому обычное переименование представлено удалением
и добавлением. Новые файлы читаются из проверенного архива в память и записываются в объекты
одним `hash-object --stdin-paths` из копий, которые хост нумерует сам: путь агента на хосте
не создаётся. Перед native apply ограничиваются размеры binary literal/delta и существующих
historical postimage объектов. Каждое изменённое итоговое содержимое читается целиком
несколькими `cat-file --batch` (до 32 МиБ за чтение), сверяется с точными значениями
учётных данных хода и один раз на весь кандидат проходит `gitleaks dir` по закрытому каталогу
с пронумерованными копиями. Пути агента в проверку не попадают (свой `.gitleaksignore`
каталога, исключения по путям), как и при чтении из stdin: конфигурация — хоста,
`gitleaks:allow` не действует. Gitleaks пропускает файлы, похожие по первым байтам на архив,
PDF или программу, поэтому каждая копия начинается с заголовка GIF: картинки он читает. Находка — только код выхода 99 (`--exit-code=99`), код 1 — его собственная ошибка.
Новый файл, который `update-index` молча не внёс в индекс (`git~1`, `.git.`), — отказ хода.
Число процессов на публикацию не зависит от числа файлов.

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
Клоны живут в `<tmpdir>/raditi-git-*`; в проде это собственный том core, и остатки после
`kill -9` роль `core` удаляет при старте (`stale-clones.ts`). Локально tmpdir общий — там
очистки нет.

## Зеркало, рабочий набор и медиа (план 53, Р10–Р12, Р27)

Сетевых клонов на ход больше нет. У каждого репозитория сайта — голое зеркало
`<GIT_MIRROR_DIR>/repos/<sha256(provider, owner, name, url)>.git` (по умолчанию
`<tmpdir>/raditi-mirrors`, не `raditi-git-*`, поэтому уборка клонов его не трогает). Коммит
назван своим содержимым: если он уже в зеркале, сеть не нужна; если нет — один `fetch` всех
веток и тегов с коротким доступом на чтение и проверкой каждого полученного объекта
(`transfer.fsckObjects`), без remote в конфигурации зеркала; `fetch --quiet` — строка на каждую
обновлённую ссылку в stderr у сайта с сотнями веток задач превысила бы 64 КиБ, а провал `fetch`
после того, как пакет уже на месте, не мешает, если нужные коммиты пришли. Одна операция с
зеркалом за раз (замок в памяти: `core` один). Корень зеркал — закрытая папка процесса: при
старте её создают с режимом 0700, свою с более широким режимом закрывают, ссылку или папку
другого пользователя (общий `/tmp` Linux) отвергают. Зеркало, чей `config` не тот, что пишет
`git init --bare` этого хоста, или с `objects/info/alternates`, создаётся заново. Каждая операция
работает в своём закрытом репозитории `<tmpdir>/raditi-git-*`: `git init` без шаблона, объекты
зеркала — через `objects/info/alternates`, свои объекты и индекс — свои; клонирования, checkout,
remote и ссылок сайта в нём нет. Все прежние ограничения команд (`-c` хуков, протоколов)
остаются; `fsck --no-full --strict` проверяет новые объекты операции и их связи через зеркало —
объекты самого зеркала проверены при получении, и зеркало в гигабайты не хешируется заново.

С `workspace.workingSet` (`SiteAdapter.agentWorkingSet()`) бандл несёт не полное дерево, а один
корневой коммит рабочего набора (`sandboxBaseSha`): дерево — файлы `expectedBaseSha`, которые
берут шаблоны набора, в отдельном индексе (`GIT_INDEX_FILE`), коммит бота без родителя во время
`committedAt` с сообщением, называющим `expectedBaseSha`. Тот же вход — тот же SHA: восстановление
выводит его заново (`sandboxBase`), а не хранит. Строгие правила репозитория (только обычные
файлы, пределы размера, не больше `repositoryFiles` файлов) — для набора и его `maxBytes`
(`working_set_too_large`); остальное полное дерево может держать ссылки, сабмодули и медиатеку
больше 128 МиБ и 100 000 файлов — агент их не видит; у полного списка свои пределы памяти
(500 000 файлов, 128 МиБ списка). Папки `addOnlyPaths` в набор не входят, даже если шаблоны их
называют: они только растут и однажды навсегда превысили бы предел песочницы.
`capture` берёт патч против `sandboxBaseSha`, исполнитель и раннер отказывают в другой базе.
`preparePublication` применяет этот патч к индексу полного `expectedBaseSha` (пути совпадают),
заново выводит `sandboxBaseSha` и отказывает в любом изменении вне набора, кроме новых медиа в
`addOnlyPaths`. `capture` берёт новые файлы этих папок и тогда, когда их скрывает `.gitignore`
сайта. Бандлы кешируются по
коммиту своей ссылки в `<GIT_MIRROR_DIR>/bundles/` (32 последних); ссылку кешированного бандла
проверяет разбор его заголовка.

`addOnlyPaths` с `media` (`SiteAdapter.mediaRules()`): под этими папками — только новые файлы
(агент не видит, что там уже лежит: файл с занятым именем — отказ публикации),
режим `100644`, без точечных имён и частей `.php`, `.pht`, `.phar`, `.htaccess`, `.user.ini`,
`.svg`, с разрешённым расширением, совпавшими сигнатурами и не больше 8 МиБ. Такая папка
перекрывает `protectedPaths`, но не пути CI. `protectedPaths` с ведущим `**/` действуют на любой
глубине.

`treeOf({repo, sha})` отдаёт дерево коммита. `compareCommits({repo, baseSha, headSha,
addOnlyPaths})` — изменение кандидата для `core` (R3): оба дерева, тот же патч, что пишет
публикация (`git diff --binary --full-index --no-renames`, не больше `patchBytes`), каждый
изменённый путь с размером и признаком исполняемого и байты файлов, добавленных в
`addOnlyPaths` (не больше 8 МиБ каждый). `rebaseCandidate` («Обновить») переносит изменения
кандидата с `fromBase` на `toBase` трёхсторонним слиянием деревьев (`merge-tree --merge-base`)
**без поиска переименований** (`-X no-renames`): правка остаётся на своём пути и не уходит вслед
за файлом, который `main` перенёс, например, в медиатеку. Результат может менять относительно
`toBase` только пути, которые кандидат изменил относительно `fromBase`; иначе — конфликт. С
`rules` (`siteWorkspaceRules`) каждый изменённый путь проходит правила кандидата, как при
публикации. Один коммит бота на `toBase` во время `committedAt`, push в `agent/<taskId>` по CAS
(ветка должна стоять на `head` или уже на результате) после `assertFence` — без ограждения вызов
отвергается; при конфликте возвращаются пути, ничего не пишется.

Git выпуска (R8b, `release-git.ts`): `trustedCommit({repo, treeOf, parent, message, committedAt})`
— коммит бота с деревом `treeOf`, единственным родителем `parent` и временем `committedAt`; тот
же вход — тот же SHA, поэтому выпуск записывает `approved_sha` до push, а повтор после сбоя
строит тот же коммит. `pushTrustedCommit(input & {branch, expected}, assertFence)` толкает его в
`refs/heads/<branch>` только по CAS (`--force-with-lease=<ref>:<expected>`): ветка на `expected`
— `pushed`, уже на коммите — `present`, где-то ещё — `moved` без push; ветки `agent/*` и имена
`refs/*` отвергаются, без ограждения вызов отвергается, потерянный ответ — исключение (вызывающий
читает ветку `readBranchHead`). Коммит выпуска — дерево головы кандидата поверх `main`, revert-
коммит — дерево установленной версии поверх коммита выпуска (`releaseCommit`, `revertCommit`).
`changeDigests({repo, baseSha, headSha})` — каждый изменённый путь (без поиска переименований,
только обычные файлы) с SHA-256 содержимого с обеих сторон: из него API выпуска строит манифест.
Тег выпуска git не ставит: его создаёт учётная запись выпуска через API провайдера (R8a).

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
Этот smoke не подтверждает HTTPS credentials API, реальный push в Gitea (их проверяет
`pnpm verify:gitea`) или Linux/runsc networking.
