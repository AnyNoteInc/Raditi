# Спайк пайплайна сайта на настоящей Gitea

```sh
docker build -f apps/orchestrator/Dockerfile --target runtime -t raditi-pipeline-verify/orchestrator:local .
pnpm verify:pipeline                      # оба прохода: спайк N18 и выкладка по тегу
pnpm verify:pipeline -- --only=tags       # только выкладка по тегу (вторая Gitea)
```

Образ `raditi-pipeline-verify/orchestrator:local` стенд не собирает: он должен быть собран из этого дерева. Старый образ несёт `deploy-step` прежнего дерева, и выкладка по тегу падает на чтении манифеста («the release API did not give this attempt its manifest»; так было 19.10.2026 с образом от 17.10). Вместо пересборки можно назвать образ, который `pnpm verify:release` уже собрал из того же дерева той же целью: `pnpm verify:pipeline -- --deploy-image=raditi-release-verify/orchestrator:local`. Два стенда с раннерами Gitea (`verify:pipeline` и `verify:release`) одновременно не запускаются: 19.10.2026 так упали оба (у спайка — шаг `backup` в Q6, у выпуска задание не начало работу за 10 минут), а по отдельности оба прошли; вероятная причина — имена контейнеров и томов заданий раннер берёт из номера задачи своей Gitea, а у каждой одноразовой Gitea номера начинаются с 1.

Проход отвечает на вопросы, на которых стоят правила 3 и 6 и кодовая половина локального гейта: что на самом деле делает Gitea 1.27.3 с обязательным workflow из `platform/ci`. Каждая строка `PASS` — наблюдение за настоящей Gitea; если ответ изменится с новым релизом, стенд упадёт. [Отчёт с ответами](../../../docs/plan/34-gitea-pipeline-spike.md); выкладка по тегу — [план 53](../../../docs/plan/53-chat-preview-release.md), Р28–Р31 и «Маршруты» (R8c).

## Что поднимается

Все ресурсы — одноразовые, свои для каждого запуска: имя `raditi-pipeline-verify-<id>-…`, метка `raditi.stand=raditi-pipeline-verify-<id>`.

- Gitea 1.27.3 со встроенным HTTPS и сертификатом собственного CA стенда, Actions включены, порт только на `127.0.0.1`. Пароли учётных записей генерирует сама Gitea (`--random-password`), стенд читает их из вывода: в аргументах процессов их нет.
- Два раннера gitea/runner 4.0.0, как два вида машин в spec §10: `check` и `deploy`. У каждого своя сеть. OpenBao и том «сайта» есть только на стороне `deploy`.
- OpenBao 2.7.0: обычный сервер в памяти, инициализация через API. Токен выкладки и одноразовую обёртку создаёт стенд через HTTP API, секрет Actions кладёт через API Gitea. Адрес OpenBao задание `deploy` получает из конфигурации своего раннера (`runner.envs`, `RADITI_VAULT_ADDR`); переменной репозитория с адресом нет — стенд это проверяет.
- Вторая Gitea с одной отличающейся настройкой — `[actions] WORKFLOW_DIRS = .git/raditi-no-repository-workflows`, как у каждой Gitea платформы. У неё свой раннер выкладки (`release`): метка `deploy` — образ orchestrator из этого дерева (`raditi-pipeline-verify/orchestrator:local`, `--deploy-image=<образ>` — другой локальный), в `runner.envs` — адрес OpenBao, адрес API выпуска (сам процесс стенда по `host.docker.internal`), CA стенда (`NODE_EXTRA_CA_CERTS`, том только на чтение) и `APP_ENV`. Рядом на сети `deploy`: SFTP-хостинг сайта (`linuxserver/openssh-server` по digest, internal-sftp, пароль — файлом до старта) и сервер страниц сайта (тот же образ orchestrator, том хостинга только на чтение, `http://site:8080`).
- Приёмник вебхуков — сам процесс стенда; Gitea достаёт его по `host.docker.internal`. Он же — API выпуска для заданий второй Gitea (`tag-scenario.mjs`: манифест, доступ, отчёты по `reportKey`, presigned PUT бэкапа и его сверка — договор `deploy-manifest.ts`).

В `platform/ci` первой Gitea стенд кладёт `ci/.gitea/scoped_workflows/check.yml`, вместо `deploy.yml` — пайплайн спайка `workflows/deploy-spike.yml` (выкладка по push в `main`, вопросы Q1–Q7) и свои пробы из `workflows/`: `probe.yml`, `probe-restricted.yml`, `cancel-probe.yml`. Во вторую Gitea — продуктовые `check.yml` и `deploy.yml` из `ci/` как есть и `workflows/push-probe.yml`. Файлы `attack.yml` и `impostor.yml` стенд коммитит в репозиторий сайта — так он измеряет, что может файл workflow в самом сайте.

Шаги выкладки первой Gitea — подмены: «сайт» — каталог `/site/<owner>/<repo>` на томе раннера `deploy`, его состояние — файл `marker`. Коммит с `raditi-fault` в сообщении «ломает сайт»: шаг `verify` падает. Во второй Gitea выкладку делает настоящая команда `deploy-step` образа orchestrator.

## Что проверяется

1. Регистрация источника: только веб-форма с сессией администратора, REST API для scoped workflows нет; организация принимает источником только свой репозиторий.
2. Обязательный workflow нельзя отключить в репозитории; необязательный — можно.
3. Права бота: секрет Actions ставит только владелец организации.
4. Push в `main` без живой обёртки: выкладка останавливается на `vault-login`. Q1 — `check` на pull request и `deploy` после merge в репозитории без файлов CI.
5. Q4 — статус опросом API и вебхуками `workflow_run` с подписью через `parseGiteaWebhook`; `workflow_job`, `pull_request`, `push`.
6. Q5 — обёртка разворачивается один раз; повторный запуск выкладки сайт не трогает.
7. Q6 — сбой `verify` запускает `rollback`.
8. Q3 — `concurrency`: одна идущая и одна ждущая выкладка на репозиторий; другой сайт не ждёт.
9. Q2 — что может сам репозиторий сайта: выключить Actions, отменить выкладку файлом workflow на ветке, запустить рядом свой workflow с тем же именем; какие условные шаги выполняет отменённый запуск.
10. Q7 — до чего дотягивается контейнер задания каждого вида и что может токен задания.
11. Настройка `WORKFLOW_DIRS`: файлы workflow в репозитории не создают запусков, scoped workflow создаёт (какой файл дал запуск, видно по `workflow.path` вебхука); push в `main` продуктовую выкладку не запускает.
12. Тег `v0.0.0` (импорт), созданный через API учётной записью выпуска, даёт ровно один запуск `deploy.yml`, задание которого `skipped` по `if:`.
13. Тег выпуска без секрета: один запуск (`push`, без ветки), в задании `gitea.ref`, `gitea.ref_name`, `gitea.sha` тега (их печатает `deploy-step match`), шаг `deploy` пропущен, API выпуска никто не зовёт.
14. Секрет другого тега: сверка до вскрытия — обёртка в OpenBao не потрачена, API выпуска не вызван.
15. Выпуск через настоящий `deploy-step`: обёртка вскрыта один раз, доступ выдан один раз после `conflicts started`, файлы коммита прочитаны токеном задания и записаны по SFTP (замена, добавление, удаление, без временных файлов), бэкап ровно заменённого и удалённого загружен, открывается ключом попытки и сверен, сайт прошёл проверку до первой записи и после последней; в логе задания нет ни одного секрета.
16. Повтор по `workflow_dispatch` (`ref: refs/tags/<тег>`, `scoped_workflow_source_repo_id`): запуск `workflow_dispatch` с теми же `gitea.ref`/`gitea.sha`, обёртка уже потрачена — ничего не вызвано и не записано; короткое имя тега и вызов без источника — 404.
17. Выпуск, который ломает главную страницу (`<b>Fatal error</b>:`) и добавляет файл в папки, которых ещё нет (`wp-content/plugins/extra/`): проверка до записи проходит, после — падает; возврат на своём SFTP-соединении восстанавливает заменённый файл из бэкапа, убирает добавленные и папки, созданные выпуском, временных файлов не остаётся; повторная проверка проходит.
18. Ровно один запуск на тег и один на `workflow_dispatch`, ни одного на push в `main`.

### Что измерено 17.10.2026 (Gitea 1.27.3, gitea/runner 4.0.0)

- Лёгкий тег через `POST /repos/{o}/{r}/tags` (как `createTag` R8a) запускает scoped workflow с `on: push: tags: ['v*']` из `platform/ci`: `event = push`, `path = deploy.yml@refs/tags/<тег>`, поля ветки у запуска в REST нет. В задании `gitea.ref = refs/tags/<тег>`, `gitea.ref_name = <тег>`, `gitea.sha` — коммит тега, `gitea.server_url` — `ROOT_URL` экземпляра (`https://gitea-hardened:3000`); токен задания (`gitea.token`) читает файлы своего репозитория через `/api/v1/repos/<repo>/raw/<путь>?ref=<sha>`.
- Защита тегов `v*` для учётной записи выпуска запуску не мешает.
- `if: … && gitea.ref_name != 'v0.0.0'` даёт запуск со `skipped` заданием, а не отсутствие запуска.
- `POST …/actions/workflows/deploy.yml/dispatches?return_run_details=true&scoped_workflow_source_repo_id=<id>` токеном бота с `{"ref": "refs/tags/<тег>"}` → 200 и `workflow_run_id`; ref без `refs/tags/` → 404 «ref "v1.0.0" doesn't exist»; без `scoped_workflow_source_repo_id` → 404.
- Задание на образе orchestrator идёт пользователем образа (uid 10001): act пишет файлы шагов и `GITHUB_OUTPUT` так, что этот пользователь их читает и дописывает.
- Вебхук организации с событиями `push` и `create` на тег, созданный через API, в этом стенде не пришёл (замер 17.10.2026); вебхук репозитория с `push` его получает (стенд R8a, `infra/dev/gitea-verify/release-scenario.mjs`). Выкладка на вебхук тега не опирается: core следит за запуском опросом и `workflow_run`.

## Запись образцов вебхуков

```sh
pnpm verify:pipeline --record=/абсолютный/каталог
```

В каталог пишутся тела вебхуков, как их прислала Gitea, с заменой адресов стенда на `gitea.example.test`. Тело, в котором нашёлся секрет запуска, имя машины, домашний каталог, любой литеральный IPv4-адрес или оставшееся имя стенда, не очищается, а отклоняется — запись падает.

Из этих файлов собраны образцы тестов `packages/git-providers/src/testing/gitea-webhooks-recorded.ts`: файл `<имя>.<событие>.json` — запись `<имя>: { event: '<событие>', body: '<содержимое файла без изменений>' }`. Модуль пишет команда

```sh
node infra/dev/pipeline-verify/build-samples.mjs /абсолютный/каталог [ГГГГ-ММ-ДД]
```

Она требует ровно десять образцов, которые называют тесты; дата по умолчанию — сегодняшняя. Тест `stand.test.mjs` сверяет, что модуль в репозитории побайтно равен тому, что команда собирает из его же тел. Подпись не хранится — тест подписывает тело своим секретом.

## Что нужно

Локальный Docker с уже загруженными образами (стенд ничего не скачивает и проверяет digest): `gitea/gitea:1.27.3-rootless`, `gitea/runner:4.0.0`, `ghcr.io/openbao/openbao:2.7.0`, `alpine:3.22`, `linuxserver/openssh-server` (digest — `HOSTING_IMAGE` в `stand.mjs`) и собранный из этого дерева образ orchestrator `raditi-pipeline-verify/orchestrator:local` (команда сборки — в начале); `openssl`; Node 26.10 (парсер вебхуков, схемы `deploy-manifest.ts` и чтение бэкапа импортируются из исходников TypeScript). Корневой `.env`, dev-инфраструктура (`raditi-dev-*`, профиль `ci`), настоящие токены и подписки не используются.

Раннеру нужен сокет Docker: это root на машине раннера. Контейнеры заданий сокета не получают (`docker_host: '-'`), но создаёт их раннер — через тот же демон, рядом с остальными контейнерами машины. Стенд поэтому убирает за собой всё, что создали задания: контейнеры — по метке и по сетям стенда, именованные тома заданий — по монтированиям и по метке `com.gitea.runner.uuid` своих раннеров. Уборка идёт в конце и при SIGINT/SIGTERM, раннеры останавливаются первыми; повторный сигнал её не обрывает. Сигнал, посланный `pnpm verify:pipeline`, доходит до стенда (`exec node …`).

Ограничения:

- На хосте Linux приёмник вебхуков слушает адрес шлюза сети `bridge`; этот путь ни разу не выполнялся. Проверено на Docker Desktop (macOS).
- Изоляции gVisor здесь нет: задания идут под `runc`, как у штатного раннера.
- Workflow в GitHub Actions для этого стенда нет.

Файлы: `verify-pipeline.mjs` — ресурсы и уборка, `scenario.mjs` — проверки спайка на первой Gitea, `tag-scenario.mjs` — выкладка по тегу на второй и API выпуска стенда, `stand.mjs` и `stand.test.mjs` — параметры контейнеров, конфигурация раннеров, очистка и сборка образцов и контракт файлов `ci/` и `workflows/deploy-spike.yml` (`pnpm test:infra`), `build-samples.mjs` — запись модуля образцов. Сама команда `deploy-step` и её тесты — `apps/orchestrator/src/deploy-step` (там же `deploy.integration.test.ts`: WordPress с плагином «Радити» и SFTP-хостинг, `RADITI_HOSTING_DOCKER_TESTS=1`); запись на хостинг — `packages/site-connections/src/hosting` (SFTP против OpenSSH, FTP(S) против vsftpd и ProFTPD — тот же флаг).
