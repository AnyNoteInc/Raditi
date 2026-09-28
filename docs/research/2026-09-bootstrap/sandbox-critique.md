**Вердикт: принять с изменениями.** Основа выбрана верно: Docker с gVisor (`runsc`, режим systrap) на обычной ВМ, отдельный контейнер на каждый ход, состояние хранится вне узла, публикацию делает платформа, у песочницы нет интернета. Почти все опорные факты подтвердились. Но в отчёте есть внутреннее противоречие в модели жизни контейнера. Кроме того, пропущены побочные эффекты хода на живом сайте. Схема «Docker API по сети» опаснее и в сумме сложнее пути, который сам отчёт откладывает на этап 2.

## 1. Что подтвердилось

| Утверждение | Статус | Источник |
|---|---|---|
| gVisor release-20260921.0 (опубликован 23.09.2026). С 2026-07 релиз состоит из нескольких файлов, автозагрузка отключается в конце сентября 2026, в 20260831.0 убраны отдельные бинарники | Верно | [install](https://gvisor.dev/docs/user_guide/install/), [releases](https://github.com/google/gvisor/releases) |
| systrap работает через seccomp и не требует аппаратной виртуализации; внутри ВМ рекомендуется systrap | Верно | [platforms](https://gvisor.dev/docs/architecture_guide/platforms/) |
| Docker Engine 29.8.1 вышел 15.09.2026 | Верно | [release notes](https://docs.docker.com/engine/release-notes/) |
| Yandex Cloud: «Вложенная виртуализация не поддерживается из соображений безопасности» | Верно | [FAQ](https://github.com/yandex-cloud/docs/blob/master/ru/_qa/compute/vm.md) |
| Daytona: с июня 2026 репозиторий не получает обновлений | Верно | [README](https://github.com/daytonaio/daytona) |
| Kimi: `-p` (`--prompt`) нельзя сочетать с `--yolo`, `--auto`, `--plan`; `workDirKey = wd_<slug>_<sha256[:12]>`; `KIMI_DISABLE_TELEMETRY`; `KIMI_MODEL_*` | Верно | [kimi-command](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html), [data-locations](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md), [env-vars](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md) |
| Флаги Qwen (`--max-wall-time`, `--max-tool-calls`, `--max-session-turns`, `QWEN_CODE_UNATTENDED_RETRY`, сессии в `~/.qwen/projects/<sanitized-cwd>`) и OpenCode (`export`/`import`, `OPENCODE_PERMISSION`) | Верно | [qwen headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), [opencode cli](https://opencode.ai/docs/cli/) |
| Claude Code: ВМ простаивающей сессии забирают, при следующем сообщении поднимается новая ВМ с историей, фоновые процессы не восстанавливаются; кэш setup — если он укладывается примерно в 5 минут; в self-hosted сессия возвращается в очередь примерно через 60 с без опроса | Верно | [cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [self-hosted](https://code.claude.com/docs/en/self-hosted-environments) |
| Codex cloud: кэш «up to 12 hours», секреты доступны только setup-скриптам | Верно | [cloud-environment](https://learn.chatgpt.com/docs/environments/cloud-environment) |
| TLS-ключ Docker даёт root; exec нельзя остановить через API | Верно | [protect-access](https://docs.docker.com/engine/security/protect-access/), [moby#9098 (открыт с 2014)](https://github.com/moby/moby/issues/9098) |
| gVisor: у `runsc --rootless` нет netstack и save/restore; изменения в оверлее корневой ФС хосту не видны | Верно | [rootless](https://gvisor.dev/docs/user_guide/rootless/), [filesystem](https://gvisor.dev/docs/user_guide/filesystem/) |
| Версии через `npm view`: codex 0.157.1, kimi-code 2.1.1, qwen-code 0.24.6, opencode-ai 1.18.32, dockerode 5.0.1, e2b 2.51.0, @kubernetes/client-node 2.0.0 | Верно (проверил сам) | npm |

Сам не проверял: ресурсы ВМ Claude (4 vCPU, 16 ГБ, 30 ГБ), лицензию CubeSandbox, фразу E2B про «evaluation package» и дату agent-sandbox v1.0.4. GitHub API упёрся в лимит запросов, а на странице релизов год не указан. Для MVP это не критично.

## 2. Неточности в отчёте

1. **Порядок флагов у `codex exec resume`.** По документации «Flags go after the `resume` subcommand» ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)). Отчёт опирается на порядок из SDK, где флаги стоят до `resume`. Документация и SDK расходятся, поэтому пункт PoC нужно сформулировать как противоречие, а не как уточнение.
2. **Не названа переменная автообновления Kimi.** Это `KIMI_CODE_NO_AUTO_UPDATE=1` ([env-vars](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md)).
3. **Недооценена зависимость Codex от Responses API.** `wire_api="chat"` удалён в феврале 2026 ([discussion #7782](https://github.com/openai/codex/discussions/7782)). У Yandex AI Studio есть `/v1/responses` ([API](https://aistudio.yandex.ru/docs/en/ai-studio/api/)). Для Cloud.ru и GigaChat нужен мост LiteLLM `/responses → /chat/completions`: поля в нём приближаются или отбрасываются, есть открытые баги ([docs](https://docs.litellm.ai/docs/response_api), [#24664](https://github.com/BerriAI/litellm/issues/24664), [#23716](https://github.com/BerriAI/litellm/issues/23716)). Основной драйвер Codex стоит на этом допущении, его нужно вынести в PoC отдельным пунктом.
4. **Противоречие с правилом 5 в CLAUDE.md.** Там написано «rootless», а отчёт предлагает dockerd с правами root. Это можно обосновать: у `runsc --rootless` нет netstack. Но spec §8 и §18 нужно явно переписать: «dockerd с root, uid 10001 в контейнере, граница — gVisor».

## 3. Слабые места

### 3.1. Модель контейнера противоречит сама себе
- CLI запускается главным процессом, потому что exec нельзя убить. Но `restore` и `fs.write` идут до `run`, а `git diff` и `snapshot` после. В остановленный контейнер exec не сделать, поэтому на ход фактически нужны 3 контейнера на общих томах: служебный, рабочий и снова служебный.
- При этом `/run/raditi/events.jsonl` лежит на tmpfs, а tmpfs между контейнерами не общий. Дочитать вывод с оффсета после смерти рабочего контейнера нельзя.
- Проще так: один контейнер на ход, PID 1 — `tini -- sleep infinity`, всё остальное через exec. Агент запускается обёрткой (`setsid`, файл с pgid, `tee` в файл с оффсетами). Отмена — `exec kill -TERM -<pgid>`, запасной вариант — `docker stop`.
- Никогда не использовать `docker cp` и `getArchive`/`putArchive`. Изменения в оверлее gVisor хосту не видны, а сам `docker cp` исторически уязвим (CVE-2018-15664, CVE-2019-14271). Байты гонять только через stdin и stdout exec.

### 3.2. Docker API по mTLS = root на песочной ВМ, а также раздвоение мозга
- Если лиза истекла из-за паузы GC или обрыва сети, старая реплика бэкенда всё ещё может сделать kill или destroy: Docker API ничего не знает о fencing.
- Каждая выкладка бэкенда рвёт 20-минутные ходы, поэтому `attach` с оффсетами становится обязательной сложной логикой уже в MVP.
- Шаблон, который отчёт сам приводит (раннеры Claude), решает всё это сразу. На песочной ВМ работает небольшой pull-раннер. Входящих портов у ВМ нет. Раннер владеет контейнером и файлом вывода, эпоха лизы проверяется при каждой команде. Выкладка бэкенда ход не прерывает.
- Писать сначала адаптер B, потом A — это двойная работа. Совет: B — только для PoC без клиентских данных, пилот — сразу на раннере. Раннер может жить в том же монорепозитории как отдельная роль запуска.

### 3.3. Побочные эффекты на живом сайте не учтены (главный пропуск)
- Контент меняется сразу через MCP (spec §11), а снимок хода содержит только файлы.
- «Изменить = восстановить ход n−1» не откатывает правки контента, сделанные ходом n.
- Повтор потерянного хода (ВМ упала, лиза ушла другой реплике) повторит неидемпотентные вызовы `wp post update`, `media_upload` и другие.
- Нужны:
  - журнал вызовов MCP на ход с ключами идемпотентности;
  - при «Изменить» и при повторе — сначала восстановление снимков объектов этого хода;
  - автоматический повтор только для хода без побочных эффектов, иначе — вопрос клиенту или оператору;
  - не больше одного работающего хода на сайт одновременно (мьютекс по `siteId`), иначе правки одной записи будут конфликтовать.

### 3.4. Сессии и снимки: лишнее и хрупкое
- `workspace.tar.zst` с `.git` на каждый ход дублирует то, что платформа и так пушит в ветку после каждого хода.
- Хуже того, если `DiffPolicy` отклонил дифф, в архиве отклонённые изменения остаются. Следующий ход строится на них, и снимок расходится с веткой.
- Для MVP проще: рабочая копия = ветка задачи во внутреннем зеркале Gitea (WIP-ветки не шумят у клиента в GitHub и GitLab), в снимок идёт только `home` и маленький архив неотслеживаемых файлов. «Изменить» = сброс ветки на коммит хода n−1 плюс `home` хода n−1.
- `SnapshotManifest` без `schemaVersion`: ломается при обновлении кода, пока сессия несколько дней ждёт в `awaiting_user`.
- `sha256` должен считать хост на потоке, а не песочница.
- `dataKey` в открытом виде внутри `SnapshotRequest`: если шифровать внутри песочницы, ключ рабочего пространства (`ws-<wsId>`) попадает к агенту. Шифровать на хосте ключом данных на каждый снимок или взять SSE-KMS облака.
- Сохранять `patch.diff` хода в S3. Тогда публикацию можно повторить, когда контейнера уже нет. Сейчас порядок «снимок → уничтожение → публикация» без сохранённого патча теряет ход при сбое публикации.
- Образы по дайджесту хранить в реестре не меньше срока хранения сессий (30 дней + 7). Иначе сборщик мусора реестра молча сломает продолжение сессий.

### 3.5. Публикация: хост всё-таки разбирает недоверенные данные
- `git apply` на хосте с учётными данными противоречит принципу 3 из отчёта. Были CVE, при которых `git apply` писал за пределы рабочего дерева ([CVE-2023-23946](https://nvd.nist.gov/vuln/detail/CVE-2023-23946), [CVE-2023-25652](https://nvd.nist.gov/vuln/detail/CVE-2023-25652)).
- Как исправить:
  1. сначала `git apply --numstat --summary` и отказ по режимам 120000 (симлинки) и 160000 (сабмодули) и по смене прав — до применения;
  2. затем `git apply --cached` (только индекс) в клоне с `--no-checkout --filter=blob:none`;
  3. включить `transfer.fsckObjects=true` и держать свежий git.
- Токен клона не должен оставаться в `.git/config` или `FETCH_HEAD` рабочей копии: подставлять его через `GIT_CONFIG_*` или `http.extraHeader`.

### 3.6. LiteLLM и MCP-шлюз — самая открытая для атаки поверхность
- [CVE-2026-42271](https://www.oligo.security/blog/oligo-detects-and-blocks-rce-in-litellm-cve-2026-42271): RCE через `POST /mcp-rest/test/connection` с ключом низких прав. Уязвимы версии 1.74.2–1.83.6, исправлено в 1.83.7, эксплуатировалась в реальных атаках. В связке с Host-bypass (CVE-2026-48710) — без аутентификации.
- Это ровно модель угроз Радити: у песочницы есть виртуальный ключ, а LiteLLM в spec §19 стоит на app-ВМ рядом с PostgreSQL и бэкендом.
- Что нужно:
  - на `sandbox-gw` — белый список путей (`POST /v1/responses`, `POST /v1/chat/completions`), а не маршрутизация по префиксу;
  - нормализация Host;
  - LiteLLM не ниже 1.83.7 (на PyPI сейчас 1.102.1), вынесенный в отдельный сетевой сегмент без доступа к базе и Vault.
- MCP-шлюз после слияния agents и engines живёт в одном процессе с оркестратором и биллингом. Уязвимость в разборе аргументов WP-CLI или в Playwright тогда отдаёт всё.
  - Та же кодовая база, но отдельный процесс и контейнер со своей AppRole (только `kv/sites/*`).
  - Браузеры Playwright — в собственных изолированных контейнерах (spec §19 и так ставит их на песочную ВМ).

### 3.7. Биллинг на недоверенных данных
- События `usage` печатает процесс, которым управляет агент. Промпт-инъекция может их подделать.
- По решениям владельца тарификация идёт в токенах по цене модели. Источник истины — журнал расходов LiteLLM по ключу хода, `usage` из CLI — только для интерфейса.
- Потерянные попытки хода клиенту не выставлять.
- Поток событий и `client_message` ограничивать по размеру и экранировать перед SSE.

### 3.8. Сеть и эксплуатация
- **Адресные пулы.** Отдельная internal-сеть на песочницу упирается в пул адресов по умолчанию: около 31 сети, дальше ошибка «could not find an available, non-overlapping IPv4 address pool» ([straz.to](https://straz.to/2021-09-08-docker-address-pools/)). Нужны `default-address-pools` с подсетями /28–/29, а `sandbox-gw` придётся подключать к каждой сети — проверить в PoC.
- **Квоты диска.** Драйвер `local` не умеет ограничивать размер тома, кроме tmpfs. «XFS prjquota на том» — это собственный механизм, а без него одна песочница заполнит диск всей ВМ. Для MVP проще: рабочая копия и `home` на tmpfs внутри лимита 4 ГБ (для тем WordPress этого хватает; сироты исчезают вместе с контейнером). Обязательно `--log-opt max-size`.
- **Зеркала пакетов в MVP не нужны:** сам отчёт признаёт, что темам WordPress сборка не нужна. Маршруты только `llm` и `mcp`, Verdaccio и прокси Composer — позже. Это меньше кода и меньше каналов утечки.
- **Доступ из России.** Docker Hub отдаёт 403 для российских IP ([Хабр](https://habr.com/ru/articles/818565/)). Нужен свой реестр (реестр Gitea), зеркало apt-репозиториев Docker и gVisor и образы, собранные в GitHub Actions.
- **Порог отказа от одиночного бинарника gVisor** — конец сентября 2026, то есть через несколько дней: ставить только из apt или полным tarball.
- **Разработка на Mac.** OrbStack для коммерческого использования платный, и оплатить его из России может быть проблемой. Colima бесплатна — её и указать по умолчанию.
- **io_uring.** По моим данным, в gVisor io_uring по умолчанию выключен. Если CLI на Bun или Node его используют, под `runsc` возможны сбои. Не проверял — добавить в PoC.
- **Таймаут тишины.** Codex в `--json` пишет событие только по завершении элемента, а долгие размышления модели дают минуты тишины. Лимит «N минут без вывода» ставить щедрым.

### 3.9. Зависимость от нерешённого вопроса
Весь путь кода завязан на импорт сайта в Gitea (spec §12). Путь «в один клик через плагин» из `docs/business.md` §2 пока не выбран. Порт `SandboxProvider` от этого не зависит, но публикация и `GitProvider` — зависят. Это решение нужно закрыть до реализации публикации.

## 4. Более простые альтернативы, которые я рассмотрел

- **Gitea Actions как исполнитель ходов** (так сделан Copilot на GitHub Actions). Отклоняю: в задание автоматически попадает `GITEA_TOKEN`, нет сетевой политики на задание, SSE пришлось бы строить на опросе, агент смешивается с доверенным контуром выкладки.
- **Kubernetes с agent-sandbox или microVM** — для MVP избыточно, тут я с отчётом согласен.
- **Отдельный лёгкий драйвер без shell для правок только контента** (цикл вызова инструментов через LiteLLM с одними MCP-инструментами, без песочницы). Возможен позже как ещё один `AgentDriver`. Даст задержку в секунды вместо старта контейнера, правило 8 не нарушает.

## 5. Изменения, при которых принимаю

1. PoC — на dockerode и локальном сокете. Пилот — на pull-раннере песочной ВМ: без входящих портов, с fencing по эпохе лизы. Docker API по TCP в прод не выставлять.
2. Один контейнер на ход: `tini + sleep`, всё через exec, агент под обёрткой с pgid и файлом событий с оффсетами. Никаких `docker cp` и archive API.
3. Рабочая копия = ветка во внутреннем Gitea, снимок = `home` плюс неотслеживаемые файлы. Хранить `patch.diff` хода. В манифесте добавить `schemaVersion`, хеш считает хост, шифрование на хосте. Образы хранить не меньше срока сессий.
4. Публикация: предпроверка `--numstat --summary` → `git apply --cached` в клоне без checkout → `fsckObjects` → свежий git.
5. Журнал MCP-вызовов с идемпотентностью. «Изменить» и повтор хода сначала откатывают контент этого хода. Не больше одного работающего хода на сайт.
6. Биллинг только по журналу LiteLLM на ключ хода. Потерянные попытки клиенту не выставлять.
7. `sandbox-gw` — белый список путей и нормализация Host. LiteLLM не ниже 1.83.7, в изолированном сегменте. MCP-шлюз и браузеры — отдельные процессы и контейнеры со своими политиками Vault.
8. MVP-сеть: только `llm` и `mcp`, без зеркал. Настроить `default-address-pools`, лимиты логов, tmpfs для рабочей копии.
9. Эксплуатация: gVisor из apt или полного tarball, свои зеркала apt и образов.
10. В spec:
    - уточнить «rootless» (§8, §18);
    - отдельный пункт PoC про Codex и Responses API на Cloud.ru и GigaChat;
    - `KIMI_CODE_NO_AUTO_UPDATE`;
    - порядок флагов `resume` — по документации.
11. До проектирования публикации решить путь подключения сайта (Gitea или плагин).

## 6. Что осталось неопределённым

- Поддерживают ли Cloud.ru Evolution, Selectel и Timeweb вложенную виртуализацию: публичного подтверждения я не нашёл.
- Можно ли поставить `runsc` на узлы Yandex Managed Kubernetes: в документации не нашёл.
- Что именно запрещает политика `auto` у Kimi в режиме `-p`: в документации это не раскрыто.
- Время старта контейнера под `runsc` и работу `docker pause` с `runsc` — только замер в PoC.

Источники: [gVisor install](https://gvisor.dev/docs/user_guide/install/), [gVisor platforms](https://gvisor.dev/docs/architecture_guide/platforms/), [gVisor filesystem](https://gvisor.dev/docs/user_guide/filesystem/), [gVisor rootless](https://gvisor.dev/docs/user_guide/rootless/), [Docker release notes](https://docs.docker.com/engine/release-notes/), [Docker protect-access](https://docs.docker.com/engine/security/protect-access/), [moby#9098](https://github.com/moby/moby/issues/9098), [Yandex FAQ](https://github.com/yandex-cloud/docs/blob/master/ru/_qa/compute/vm.md), [Daytona](https://github.com/daytonaio/daytona), [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex cloud env](https://learn.chatgpt.com/docs/environments/cloud-environment), [Codex discussion #7782](https://github.com/openai/codex/discussions/7782), [Kimi command](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html), [Kimi env-vars](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md), [Kimi data-locations](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/data-locations.md), [Qwen headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/), [OpenCode CLI](https://opencode.ai/docs/cli/), [Claude Code cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Claude self-hosted](https://code.claude.com/docs/en/self-hosted-environments), [Yandex AI Studio API](https://aistudio.yandex.ru/docs/en/ai-studio/api/), [LiteLLM /responses](https://docs.litellm.ai/docs/response_api), [LiteLLM #24664](https://github.com/BerriAI/litellm/issues/24664), [LiteLLM #23716](https://github.com/BerriAI/litellm/issues/23716), [CVE-2026-42271 (Oligo)](https://www.oligo.security/blog/oligo-detects-and-blocks-rce-in-litellm-cve-2026-42271), [CSA note](https://labs.cloudsecurityalliance.org/research/csa-research-note-litellm-cve-2026-42271-ai-gateway-exploita/), [CVE-2023-23946](https://nvd.nist.gov/vuln/detail/CVE-2023-23946), [CVE-2023-25652](https://nvd.nist.gov/vuln/detail/CVE-2023-25652), [Docker address pools](https://straz.to/2021-09-08-docker-address-pools/), [Docker Hub в РФ (Хабр)](https://habr.com/ru/articles/818565/), [gitleaks releases](https://github.com/gitleaks/gitleaks/releases/latest). Контекст проекта: `docs/spec.md` (§7, §8, §11, §12, §14, §15, §19), `CLAUDE.md`.