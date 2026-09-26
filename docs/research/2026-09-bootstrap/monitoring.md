# Мониторинг (Prometheus + Grafana) и точные теги образов для `infra/dev/docker-compose.yml`

Файлы я не менял. Все данные сверены 26.09.2026 через API Docker Hub, GHCR, quay.io, gitea.com и GitHub, через `npm view` и документацию проектов. Сами образы я не запускал: Docker Desktop на машине выключен. Поэтому поведение на macOS в разделе 4 взято из документации и чужого опыта, а не проверено на этой машине.

## 0. Главное

1. **`gitea/act_runner:latest` устарел.** Проект переименован в `gitea/runner` ([v1.0.0](https://gitea.com/gitea/runner/releases), 05.05.2026). Старый образ застыл на 0.6.1 от апреля 2026 года. Актуальная версия — `gitea/runner:4.0.0` (24.09.2026). Метрики раннера теперь называются `gitea_runner_*`, а не `act_runner_*`.
2. **У LiteLLM новая схема версий.** Суффикса `-stable` больше нет, стабильные версии — обычный semver ([release cycle](https://docs.litellm.ai/docs/proxy/release_cycle)). Тег `main-stable` сейчас указывает на тот же образ, что `v1.102.1` (digest `sha256:87f34979…`). В марте 2026 года пакеты LiteLLM на PyPI были скомпрометированы ([блог LiteLLM](https://docs.litellm.ai/blog/security-update-march-2026)), поэтому LiteLLM стоит закреплять по digest.
3. **Prometheus в LiteLLM открытый, не enterprise.** С v1.85.0 `/metrics` по умолчанию требует ключ. С v1.101.0 есть отдельный порт метрик `--prometheus_metrics_port` без авторизации ([docs](https://docs.litellm.ai/docs/proxy/prometheus)).
4. **OpenBao в dev-режиме уже отдаёт метрики без токена.** Dev-конфиг включает `telemetry { prometheus_retention_time = "24h" }` ([config.go#L203](https://github.com/openbao/openbao/blob/v2.7.0/internal/command/server/config.go#L203)). Кроме того, dev-режим принудительно ставит `UnauthenticatedMetricsAccess = true` ([server.go#L974](https://github.com/openbao/openbao/blob/v2.7.0/internal/command/server.go#L974)). В проде это нужно настроить вручную.
5. **Рекомендую отдельный профиль `monitoring`, а не постоянный запуск.** Это в духе профилей `site`, `llm` и `ci`, и мониторинг не отнимает около 0,5 ГБ памяти, когда он не нужен (оценка). Сами метрики в базовых сервисах (Gitea, SeaweedFS, LiteLLM) включаем всегда, это почти ничего не стоит. Кто хочет мониторинг постоянно — пишет `COMPOSE_PROFILES=monitoring` в `.env`.
6. **Все порты в текущем compose открыты на `0.0.0.0`.** Postgres с `raditi/raditi`, OpenBao с root-токеном, Gitea видны из локальной сети. Предлагаю ставить префикс `127.0.0.1:` у всех опубликованных портов.

---

## 1. Задача B — точные теги для текущих сервисов

| Сервис | Сейчас | Предлагаю | Digest (индекс) | Дата | Источник |
|---|---|---|---|---|---|
| postgres | `postgres:17-alpine` | `postgres:17.11-alpine3.24` | `sha256:b0f9560a…52b24` | 21.09.2026 | [Hub tags](https://hub.docker.com/v2/repositories/library/postgres/tags?name=17.&ordering=last_updated) |
| redis *(зависит от решения по Redis)* | `redis:7-alpine` | `redis:8.8.3-alpine` или `valkey/valkey:9.0.6-alpine`; последняя 7.x — `7.4.11-alpine` | `0b2b77d3…` / `187679e3…` | 25.09 / 21.09 | [redis](https://hub.docker.com/_/redis), [valkey](https://hub.docker.com/r/valkey/valkey) |
| s3 | `chrislusf/seaweedfs:latest` | `chrislusf/seaweedfs:4.47` | `sha256:ce9e796f…bf882` (= `latest`) | 14.09.2026 | [releases 4.47](https://github.com/seaweedfs/seaweedfs/releases/tag/4.47) |
| s3-init | `amazon/aws-cli:latest` | `amazon/aws-cli:2.37.4` | `sha256:fdd8d1fc…7ead6` | 25.09.2026 | [Hub](https://hub.docker.com/r/amazon/aws-cli/tags) |
| vault | `ghcr.io/openbao/openbao:latest` | `ghcr.io/openbao/openbao:2.7.0` (ветка 2.6 — `2.6.3`) | `sha256:71156a1c…d1315` | 23.09.2026 | [v2.7.0](https://github.com/openbao/openbao/releases/tag/v2.7.0) |
| gitea | `gitea/gitea:1.27-rootless` | `gitea/gitea:1.27.3-rootless` | `sha256:1c17ecae…845f2` | 29.08.2026 | [v1.27.3](https://github.com/go-gitea/gitea/releases/tag/v1.27.3) |
| runner | `gitea/act_runner:latest` (устарел) | **`gitea/runner:4.0.0`** (консервативно — `3.5.0`) | `sha256:7b5aa113…4689f` | 24.09.2026 | [gitea.com/gitea/runner/releases](https://gitea.com/gitea/runner/releases) |
| litellm | `ghcr.io/berriai/litellm:main-stable` | `ghcr.io/berriai/litellm:v1.102.1` | `sha256:87f34979…d0d02` | 23.09.2026 | [release cycle](https://docs.litellm.ai/docs/proxy/release_cycle) |
| site-db | `mariadb:11.4` | `mariadb:11.4.13` | `sha256:70cc072b…1338b` | 18.09.2026 | [Hub](https://hub.docker.com/_/mariadb) |
| site | `wordpress:php8.3-apache` | `wordpress:7.1.2-php8.3-apache` | `sha256:8ae73d59…822d5` | 25.09.2026 | [WP API](https://api.wordpress.org/core/version-check/1.7/): текущая версия 7.1.2 |
| wpcli | `wordpress:cli-php8.3` | `wordpress:cli-2.12.0-php8.3` | `sha256:0f7f0f89…ccac0` | 25.09.2026 | [Hub](https://hub.docker.com/_/wordpress) |

Примечания:
- **PostgreSQL.** Есть уже `18.6-alpine3.24`. Если по примеру Node и pnpm брать максимальные версии, это отдельное решение: совместимость Prisma 7 с PG 18 я не проверял.
- **MariaDB.** Тег `mariadb:lts` теперь указывает на **12.3.3**, а не на 11.4. Ветка 11.4 по-прежнему LTS.
- **WordPress.** Digest `php8.3-apache` отличается от `7.1.2-php8.3-apache` только набором платформ: в первом есть riscv64. На arm64 и amd64 содержимое одинаковое.
- **Apple Silicon.** У всех выбранных образов есть arm64, я проверил манифесты: litellm, openbao, gitea, runner, aws-cli, postgres, grafana, prometheus, cadvisor.
- **Свежие релизы.** Prometheus 3.15.0, OpenBao 2.7.0 и runner 4.0.0 вышли 2–3 дня назад. Для прода есть альтернативы: Prometheus LTS `v3.13.3`, OpenBao `2.6.3`, runner `3.5.0`.
- **Если Redis останется,** есть вопрос лицензии. Redis 8 выходит под RSALv2/SSPLv1/AGPLv3, Valkey — под BSD. Это к решению владельца «зачем нам Redis».

---

## 2. Задача A — мониторинг

### 2.1 Образы мониторинга

| Компонент | Тег | Digest | Дата | Нужен в dev на Mac? | Источник |
|---|---|---|---|---|---|
| Prometheus | `prom/prometheus:v3.15.0` (LTS — `v3.13.3`, поддержка до 31.07.2027) | `efd719c9…` | 25.09.2026 | да | [changelog](https://github.com/prometheus/prometheus/blob/v3.15.0/CHANGELOG.md), [LTS](https://prometheus.io/docs/introduction/release-cycle/) |
| Grafana OSS | `grafana/grafana:13.2.2` | `ac461fb3…` (= `latest`) | 15.09.2026 | да | [v13.2.2](https://github.com/grafana/grafana/releases/tag/v13.2.2) |
| postgres-exporter | `quay.io/prometheuscommunity/postgres-exporter:v0.20.1` (есть и на Docker Hub) | `ac5ec343…` | 08.07.2026 | да | [v0.20.1](https://github.com/prometheus-community/postgres_exporter/releases/tag/v0.20.1) |
| blackbox-exporter | `prom/blackbox-exporter:v0.28.0` (новее нет) | `e753ff9f…` | 06.12.2025 | да | [v0.28.0](https://github.com/prometheus/blackbox_exporter/releases/tag/v0.28.0) |
| cAdvisor | `ghcr.io/google/cadvisor:v0.60.6` | `b8e7d109…` | 18.09.2026 | нет, отдельный профиль | [releases](https://github.com/google/cadvisor/releases/tag/v0.60.6) |
| node-exporter | `prom/node-exporter:v1.12.1` | `1b4e4438…` | 14.07.2026 | нет, только Linux | [Hub](https://hub.docker.com/r/prom/node-exporter) |
| mysqld-exporter | `prom/mysqld-exporter:v0.20.0` | `abed8dac…` | 13.08.2026 | не рекомендую | [README](https://github.com/prometheus/mysqld_exporter/blob/v0.20.0/README.md) |
| redis_exporter | `oliver006/redis_exporter:v1.92.0` | `ca3abd5f…` | 23.09.2026 | только если останется Redis/Valkey | [Hub](https://hub.docker.com/r/oliver006/redis_exporter) |
| Alertmanager | `prom/alertmanager:v0.34.1` | — | 17.09.2026 | позже, в проде | [Hub](https://hub.docker.com/r/prom/alertmanager) |

Про реестры:
- Образ `grafana/grafana-oss` с версии 12.4.0 не обновляется: он застыл на 13.0.2. Использовать `grafana/grafana`, это тот же OSS ([docs](https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/)).
- cAdvisor с v0.53.0 публикуется только в `ghcr.io/google/cadvisor`. Реестр `gcr.io/cadvisor/cadvisor` застыл на v0.55.1 ([README](https://github.com/google/cadvisor/blob/master/README.md)).

### 2.2 Откуда каждый сервис отдаёт метрики

| Сервис | Адрес для сбора | Авторизация | Что включить | Источник |
|---|---|---|---|---|
| SeaweedFS (`weed server`) | `s3:9324/metrics`: мастер, volume, filer и S3 в одном процессе, метрики `SeaweedFS_s3_request_total{type,code,bucket}`, `SeaweedFS_s3_bucket_size_bytes` и т. д.; проверка живости — `s3:8333/healthz` | нет | флаг `-metricsPort=9324` | [server.go#L71](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/command/server.go#L71), [stats/metrics.go](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/stats/metrics.go), [s3api_server.go#L770](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/s3api/s3api_server.go#L770) |
| OpenBao dev | `vault:8200/v1/sys/metrics?format=prometheus`, метрики с префиксом `vault_*` | в dev не нужна | ничего | см. п. 0.4; [API](https://openbao.org/api-docs/system/metrics/) |
| OpenBao в проде | то же | токен с `read` на `sys/metrics` **или** `listener "tcp" { telemetry { unauthenticated_metrics_access = true } }` на внутреннем листенере | блок `telemetry { prometheus_retention_time = "24h", disable_hostname = true }` | [telemetry](https://openbao.org/docs/configuration/telemetry/) |
| Gitea 1.27.3 | `gitea:3000/metrics`, метрики `gitea_*`: репозитории, пользователи, hooktasks, плюс `go_*`; **метрик Actions нет**; проверка живости — `/api/healthz` | Bearer, если задан `TOKEN` | `GITEA__metrics__ENABLED=true`, в проде ещё `GITEA__metrics__TOKEN` | [app.example.ini#L2704](https://github.com/go-gitea/gitea/blob/v1.27.3/custom/conf/app.example.ini#L2704), [metrics.go](https://github.com/go-gitea/gitea/blob/v1.27.3/routers/web/metrics.go), [collector.go](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/metrics/collector.go) |
| gitea/runner 4.0.0 | `runner:9101/metrics`, метрики `gitea_runner_job_*`, `_poll_*`, `_client_*`; проверки `/healthz`, `/readyz` | нет, адрес закрывать сетью | в конфиге раннера `metrics.enabled: true`, `addr: ":9101"` через `CONFIG_FILE` | [config.example.yaml#L298](https://gitea.com/gitea/runner/src/tag/v4.0.0/internal/pkg/config/config.example.yaml) |
| LiteLLM v1.102.1 | `litellm:4001/metrics` (отдельный порт) или `:4000/metrics` с Bearer; проверка живости — `/health/liveliness` без авторизации | на 4001 нет, на 4000 ключ | `litellm_settings.callbacks: ["prometheus"]` и флаг `--prometheus_metrics_port 4001`; **не enterprise** (enterprise только у метрик managed batches) | [prometheus](https://docs.litellm.ai/docs/proxy/prometheus), [health](https://docs.litellm.ai/docs/proxy/health) |
| act_runner (старый образ) | неприменимо — заменить на `gitea/runner` | | | |
| MariaDB / WordPress | `mysqld-exporter:9104`, нужен пользователь с `PROCESS, REPLICATION CLIENT, SELECT` | пароль в `MYSQLD_EXPORTER_PASSWORD`, `DATA_SOURCE_NAME` больше нет | **Рекомендую не ставить:** тестовая база сайта — не наша платформа. Для сайта достаточно проверки blackbox по `site:80` | [README](https://github.com/prometheus/mysqld_exporter/blob/v0.20.0/README.md) |
| Next.js 16 (`apps/web`) | `host.docker.internal:3000/api/metrics` | Bearer `METRICS_TOKEN` | `prom-client@15.1.3` в обработчике маршрута, реестр — синглтон на `globalThis` | см. 2.8 |
| NestJS (backend) | `host.docker.internal:8081/metrics` | через guard или закрытая сеть | `@willsoto/nestjs-prometheus@6.1.1` и `prom-client@15.1.3` | см. 2.8 |
| Docker Desktop (движок) | `host.docker.internal:9323/metrics` | нет | в Docker Engine JSON `"metrics-addr": "127.0.0.1:9323"`; только метрики самого движка, не контейнеров | [docs](https://docs.docker.com/engine/daemon/prometheus/) |
| gVisor (прод) | `runsc metric-server` | нет | флаг `--metric-server=` в runtimeArgs для `runsc` | [gVisor observability](https://gvisor.dev/docs/user_guide/observability/) |

**Про LiteLLM и 152-ФЗ.** По умолчанию метрики LiteLLM несут метки `end_user`, `client_ip`, `user_agent`, а в режиме `user_email` — ещё и почту. Предлагаю `prometheus_exclude_labels`. Кроме того, **Prometheus не годится для тарификации**: он теряет точность. Токены и деньги для `credit_ledger` берём из журнала расходов или callback'ов LiteLLM. Метки `task_id`, `site_id` и `user_id` в метрики не кладём никогда — от них взрывается число рядов.

### 2.3 Правки существующих сервисов (фрагменты)

```yaml
  postgres:
    image: postgres:17.11-alpine3.24
    ports: ["127.0.0.1:5432:5432"]

  s3:
    image: chrislusf/seaweedfs:4.47
    command: server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -metricsPort=9324
    ports: ["127.0.0.1:8333:8333"]

  s3-init:
    image: amazon/aws-cli:2.37.4

  vault:
    image: ghcr.io/openbao/openbao:2.7.0
    ports: ["127.0.0.1:8200:8200"]
    # метрики в dev уже включены и без токена: /v1/sys/metrics?format=prometheus

  gitea:
    image: gitea/gitea:1.27.3-rootless
    environment:
      # ...существующие переменные...
      GITEA__metrics__ENABLED: "true"
      # В проде обязательно: GITEA__metrics__TOKEN из Vault
    ports: ["127.0.0.1:3300:3000", "127.0.0.1:2222:2222"]

  # act_runner переименован: образ gitea/runner, переменные GITEA_* те же
  runner:
    image: gitea/runner:4.0.0
    profiles: ["ci"]
    depends_on: [gitea]
    environment:
      GITEA_INSTANCE_URL: http://gitea:3000
      GITEA_RUNNER_REGISTRATION_TOKEN: ${GITEA_RUNNER_TOKEN:-}
      GITEA_RUNNER_NAME: raditi-dev-runner
      GITEA_RUNNER_LABELS: check:docker://node:22-bookworm,deploy:docker://node:22-bookworm  # выровнять с решением по Node
      CONFIG_FILE: /config/runner.yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - runnerdata:/data
      - ./runner.yaml:/config/runner.yaml:ro

  litellm:
    image: ghcr.io/berriai/litellm:v1.102.1@sha256:87f34979b9f8cb274fac90ca8a4fdda07d8480de22755562a26adeb95ce20d02
    command: ["--config", "/app/config.yaml", "--port", "4000", "--prometheus_metrics_port", "4001"]
    ports: ["127.0.0.1:4000:4000"]   # 4001 НЕ публикуем: там нет авторизации

  site-db:
    image: mariadb:11.4.13
  site:
    image: wordpress:7.1.2-php8.3-apache
    ports: ["127.0.0.1:8080:80"]
  wpcli:
    image: wordpress:cli-2.12.0-php8.3
```

`infra/dev/runner.yaml` (новый файл):
```yaml
# Остальные поля — по умолчанию. Метрики без авторизации: порт наружу не публикуем.
metrics:
  enabled: true
  addr: ":9101"
```

Добавка в `infra/dev/litellm.config.yaml`:
```yaml
litellm_settings:
  drop_params: true
  callbacks: ["prometheus"]
  # Персональные данные в метрики не пускаем. Неизвестная метка валит старт — проверить при первом запуске.
  prometheus_exclude_labels: ["end_user", "client_ip", "user_agent"]
```

### 2.4 Новые сервисы (профиль `monitoring`)

```yaml
  # Мониторинг: docker compose --env-file .env -f infra/dev/docker-compose.yml --profile monitoring up -d
  # Grafana — http://localhost:3030 (admin / GRAFANA_ADMIN_PASSWORD), Prometheus — http://localhost:9090
  prometheus:
    image: prom/prometheus:v3.15.0
    profiles: ["monitoring"]
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=7d
      - --web.enable-lifecycle          # перечитать конфиг: curl -X POST localhost:9090/-/reload
    extra_hosts: ["host.docker.internal:host-gateway"]   # на Mac не нужно, на Linux обязательно
    ports: ["127.0.0.1:9090:9090"]
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./monitoring/rules:/etc/prometheus/rules:ro
      - promdata:/prometheus
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/ready"]
      interval: 10s
      timeout: 3s
      retries: 10

  grafana:
    image: grafana/grafana:13.2.2
    profiles: ["monitoring"]
    depends_on: [prometheus]
    environment:
      GF_SERVER_ROOT_URL: http://localhost:3030/
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-raditi-dev}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
      # Никаких обращений к grafana.com и stats.grafana.org
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false"
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false"
      GF_NEWS_NEWS_FEED_ENABLED: "false"
      GF_PLUGINS_PREINSTALL_DISABLED: "true"
    ports: ["127.0.0.1:3030:3000"]
    volumes:
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./monitoring/grafana/dashboards:/etc/grafana/dashboards:ro
      - grafanadata:/var/lib/grafana

  postgres-exporter:
    image: quay.io/prometheuscommunity/postgres-exporter:v0.20.1
    profiles: ["monitoring"]
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATA_SOURCE_URI: postgres:5432/raditi?sslmode=disable
      DATA_SOURCE_USER: raditi
      DATA_SOURCE_PASS: raditi

  blackbox:
    image: prom/blackbox-exporter:v0.28.0
    profiles: ["monitoring"]
    command: ["--config.file=/etc/blackbox/blackbox.yml"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes:
      - ./monitoring/blackbox.yml:/etc/blackbox/blackbox.yml:ro

  # Только на Linux: на Mac показывает Linux-ВМ Docker Desktop, а не контейнеры macOS (см. раздел 4).
  cadvisor:
    image: ghcr.io/google/cadvisor:v0.60.6
    profiles: ["monitoring-host"]
    privileged: true
    devices: ["/dev/kmsg:/dev/kmsg"]
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro

volumes:
  # ...существующие...
  promdata:
  grafanadata:
```

Переменную `GRAFANA_ADMIN_PASSWORD` добавить в `.env.example`. `METRICS_TOKEN` (для web и backend) — и в `.env.example`, и в `globalEnv` в `turbo.json`, по правилу из CLAUDE.md.

### 2.5 `infra/dev/monitoring/prometheus.yml`

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels: { env: dev }

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: prometheus
    static_configs: [{ targets: ["localhost:9090"] }]

  # --- Приложения на хосте (pnpm dev). Docker Desktop пробрасывает host.docker.internal на хост.
  - job_name: web
    metrics_path: /api/metrics
    authorization:
      credentials: raditi-dev-metrics      # только dev; в проде — credentials_file из Vault Agent
    static_configs: [{ targets: ["host.docker.internal:3000"], labels: { app: web } }]

  - job_name: backend
    metrics_path: /metrics
    authorization:
      credentials: raditi-dev-metrics
    static_configs: [{ targets: ["host.docker.internal:8081"], labels: { app: backend } }]

  # --- Инфраструктура в compose
  - job_name: postgres
    static_configs: [{ targets: ["postgres-exporter:9187"] }]

  - job_name: seaweedfs
    static_configs: [{ targets: ["s3:9324"] }]

  - job_name: openbao
    metrics_path: /v1/sys/metrics
    params: { format: ["prometheus"] }
    static_configs: [{ targets: ["vault:8200"] }]

  - job_name: gitea
    static_configs: [{ targets: ["gitea:3000"] }]

  - job_name: gitea-runner          # профиль ci; без него цель будет down — это нормально
    static_configs: [{ targets: ["runner:9101"] }]

  - job_name: litellm               # профиль llm
    static_configs: [{ targets: ["litellm:4001"] }]

  # --- Проверки доступности через blackbox
  - job_name: blackbox-http
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      - targets:
          - http://host.docker.internal:3000/api/health
          - http://host.docker.internal:8081/health
          - http://host.docker.internal:8082/health     # MCP-шлюз, если отдельный порт
          - http://gitea:3000/api/healthz
          - http://vault:8200/v1/sys/health
          - http://s3:8333/healthz
          - http://litellm:4000/health/liveliness
          - http://site:80/                              # профиль site
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox:9115

  - job_name: blackbox-exporter
    static_configs: [{ targets: ["blackbox:9115"] }]

  # Необязательно: метрики движка Docker Desktop (включить metrics-addr в настройках)
  # - job_name: docker-engine
  #   static_configs: [{ targets: ["host.docker.internal:9323"] }]
```

Prometheus не подставляет переменные окружения в `prometheus.yml`, поэтому dev-токен здесь записан строкой. Флаг `--log.level` в 3.15 объявлен устаревшим, я его не использую.

`infra/dev/monitoring/blackbox.yml`:
```yaml
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      preferred_ip_protocol: ip4   # host.docker.internal иначе сначала пробует IPv6
      follow_redirects: true
  tcp_connect:
    prober: tcp
    timeout: 5s
```

`infra/dev/monitoring/rules/raditi.yml` — стартовые алерты по spec §19. Имена `raditi_*` — это мои предложения, их ещё нет в коде:
```yaml
groups:
  - name: raditi
    rules:
      - alert: TaskQueuedTooLong
        expr: max(raditi_task_oldest_queued_age_seconds) > 600
        for: 1m
      - alert: DeployFailed
        expr: sum(increase(raditi_deploys_total{result="failed"}[15m])) > 0
      - alert: DeployRolledBack
        expr: sum(increase(raditi_deploys_total{result="rolled_back"}[15m])) > 0
      - alert: LlmProviderErrors
        expr: sum by (api_provider) (rate(litellm_deployment_failure_responses_total[5m])) > 0.1
        for: 5m
      - alert: ServiceDown
        expr: up{job=~"postgres|seaweedfs|openbao|gitea"} == 0
        for: 2m
      - alert: EndpointDown
        expr: probe_success == 0
        for: 2m
```
Без Alertmanager алерты видны только в интерфейсе Prometheus. Alertmanager `v0.34.1` добавим в проде. Каналы: почта или MAX, потому что Telegram в РФ замедлен (spec §19).

### 2.6 Настройка Grafana из файлов

`monitoring/grafana/provisioning/datasources/prometheus.yml`:
```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      httpMethod: POST
      timeInterval: 15s
      prometheusType: Prometheus
```

`monitoring/grafana/provisioning/dashboards/raditi.yml`:
```yaml
apiVersion: 1
providers:
  - name: raditi
    orgId: 1
    folder: Радити
    folderUid: raditi
    type: file
    disableDeletion: true
    allowUiUpdates: false
    updateIntervalSeconds: 30
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: false
```
Формат взят из [документации по provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/).

**Важно для Grafana 13.** Экспорт дашборда из интерфейса теперь выдаёт схему v2. Файловое provisioning её отклоняет с ошибкой «dashboard appears to be in v2 format» ([#123607](https://github.com/grafana/grafana/issues/123607), [#126641](https://github.com/grafana/grafana/issues/126641)). Поэтому дашборды держим в классическом JSON (v1, `panels[]`, `schemaVersion`) и правим руками или скриптом, а не экспортом из интерфейса.

Стартовый дашборд `monitoring/grafana/dashboards/raditi-overview.json` (классический формат, сокращённо):
```json
{
  "uid": "raditi-overview",
  "title": "Радити — обзор",
  "tags": ["raditi"],
  "schemaVersion": 41,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "panels": [
    { "id": 1, "type": "stat", "title": "Сервисы", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 6 },
      "targets": [{ "refId": "A", "expr": "up", "legendFormat": "{{job}}" }],
      "fieldConfig": { "defaults": { "mappings": [{ "type": "value", "options": {
        "0": { "text": "НЕТ", "color": "red", "index": 0 }, "1": { "text": "ОК", "color": "green", "index": 1 } } }] } },
      "options": { "colorMode": "background", "reduceOptions": { "calcs": ["lastNotNull"] } } },
    { "id": 2, "type": "stat", "title": "Проверки доступности", "gridPos": { "x": 12, "y": 0, "w": 12, "h": 6 },
      "targets": [{ "refId": "A", "expr": "probe_success", "legendFormat": "{{instance}}" }],
      "options": { "colorMode": "background", "reduceOptions": { "calcs": ["lastNotNull"] } } },
    { "id": 3, "type": "timeseries", "title": "Задачи по статусам", "gridPos": { "x": 0, "y": 6, "w": 12, "h": 8 },
      "targets": [{ "refId": "A", "expr": "sum by (status) (raditi_tasks)", "legendFormat": "{{status}}" }] },
    { "id": 4, "type": "timeseries", "title": "LLM: запросы/с по модели", "gridPos": { "x": 12, "y": 6, "w": 12, "h": 8 },
      "targets": [{ "refId": "A", "expr": "sum by (requested_model) (rate(litellm_proxy_total_requests_metric_total[5m]))" }] },
    { "id": 5, "type": "timeseries", "title": "LLM: токены за час", "gridPos": { "x": 0, "y": 14, "w": 12, "h": 8 },
      "targets": [{ "refId": "A", "expr": "sum by (model) (increase(litellm_total_tokens_metric_total[1h]))" }] },
    { "id": 6, "type": "timeseries", "title": "LLM: задержка p95, с", "gridPos": { "x": 12, "y": 14, "w": 12, "h": 8 },
      "targets": [{ "refId": "A", "expr": "histogram_quantile(0.95, sum by (le, model) (rate(litellm_request_total_latency_metric_bucket[5m])))" }] },
    { "id": 7, "type": "timeseries", "title": "PostgreSQL: соединения", "gridPos": { "x": 0, "y": 22, "w": 8, "h": 7 },
      "targets": [{ "refId": "A", "expr": "sum by (datname) (pg_stat_activity_count)" }] },
    { "id": 8, "type": "timeseries", "title": "S3: запросы/с", "gridPos": { "x": 8, "y": 22, "w": 8, "h": 7 },
      "targets": [{ "refId": "A", "expr": "sum by (type) (rate(SeaweedFS_s3_request_total[5m]))" }] },
    { "id": 9, "type": "timeseries", "title": "Node.js: задержка event loop p99", "gridPos": { "x": 16, "y": 22, "w": 8, "h": 7 },
      "targets": [{ "refId": "A", "expr": "nodejs_eventloop_lag_p99_seconds", "legendFormat": "{{app}}" }] }
  ]
}
```
Готовые дашборды LiteLLM лежат в репозитории `cookbook/litellm_proxy_server/grafana_dashboard`. Дашборды с grafana.com (PostgreSQL 9628, Node Exporter Full 1860) лучше скачать заранее и положить файлом. Доступность grafana.com из РФ я не проверял.

### 2.7 Предлагаемые метрики платформы (мало вариантов меток)

- **backend:**
  - `raditi_tasks{status}` — gauge, считается из Postgres в `collect()` в момент сбора, поэтому верна при нескольких репликах и после рестарта;
  - `raditi_task_oldest_queued_age_seconds`;
  - `raditi_tasks_finished_total{status,driver,model_class}`;
  - `raditi_agent_turn_duration_seconds{driver}`, `raditi_agent_turn_timeouts_total{driver}`;
  - `raditi_sandbox_start_seconds`;
  - `raditi_deploys_total{result}`, `raditi_deploy_duration_seconds`;
  - `raditi_mcp_tool_calls_total{adapter,tool,result}`;
  - `raditi_credit_ledger_ops_total{op="reserve|charge|refund"}`.
- **web:** `raditi_web_sse_connections`.
- **Про порты.** Метка `driver` — это просто значение, ветвлений по драйверу в коде она не создаёт. Сами песочницы Prometheus не опрашивает: они живут минуты. Их данные приходят событиями `usage` и `completed` в оркестратор. MCP-шлюз стоит вынести на отдельный порт (например, :8082): тогда разрешённая песочнице сеть не открывает API оркестратора и его `/metrics`.

### 2.8 Метрики в приложениях

**NestJS.** Последняя версия — `@nestjs/core@12.1.0`, вышла 23.09. NestJS 12 — только ESM (`"type": "module"`), а в CLAUDE.md пока записан NestJS 11.
- `@willsoto/nestjs-prometheus@6.1.1` (08.09.2026) в peerDependencies принимает `@nestjs/common ^12.0.0` и собран против Nest 12.0.1. Исправление 6.1.1 «import nest types from package root» — как раз под ESM-экспорты Nest 12 ([CHANGELOG](https://github.com/willsoto/nestjs-prometheus/blob/main/CHANGELOG.md)).
- Сам пакет CommonJS. На Node ≥ 22.12 `require(esm)` работает без флагов.
- Нужен `prom-client@15.1.3`: это последняя версия, хоть и вышла в 2024 году.

```ts
PrometheusModule.register({ path: '/metrics', defaultMetrics: { enabled: true }, defaultLabels: { app: 'backend' } })
// providers: makeGaugeProvider({ name: 'raditi_tasks', help: '…', labelNames: ['status'] }), …
// С 6.1.0 collect() поддерживает DI — удобно для gauge из репозитория задач.
```
`/metrics` закрыть: свой контроллер-наследник `PrometheusController` с guard на `METRICS_TOKEN`, либо ограничить прокси.

**Next.js 16** (`next@16.3.6`): обработчик маршрута на `prom-client`. OpenTelemetry в Next даёт только трассировку, метрик приложения из коробки нет; трассировку «от сообщения до выкладки» подключим позже через OTel.

```ts
// apps/web/src/server/metrics.ts — синглтон: HMR в dev иначе падает на «metric already registered»
import { Registry, collectDefaultMetrics, Gauge } from 'prom-client'
const create = () => {
  const registry = new Registry()
  registry.setDefaultLabels({ app: 'web' })
  collectDefaultMetrics({ register: registry })
  return { registry, sse: new Gauge({ name: 'raditi_web_sse_connections', help: 'Open SSE streams', registers: [registry] }) }
}
const g = globalThis as { __raditiMetrics?: ReturnType<typeof create> }
export const metrics = (g.__raditiMetrics ??= create())

// apps/web/src/app/api/metrics/route.ts
import { connection } from 'next/server'
import { metrics } from '@/server/metrics'
export async function GET(req: Request) {
  await connection() // при cacheComponents GET без runtime-данных пререндерится при сборке
  const token = process.env.METRICS_TOKEN
  if (!token || req.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 })
  return new Response(await metrics.registry.metrics(), { headers: { 'content-type': metrics.registry.contentType } })
}
```
- При `cacheComponents: true` в обработчике маршрута нельзя экспортировать `dynamic`, `revalidate`, `fetchCache` и `runtime`: будет ошибка сборки ([cache components](https://nextjs.org/docs/app/guides/migrating-to-cache-components)). По умолчанию и так используется Node runtime.
- `/api/metrics` нужно исключить из matcher в `proxy.ts`, чтобы запрос не уводило на вход.
- Если Turbopack будет жаловаться на `prom-client`, добавить его в `serverExternalPackages`.

---

## 3. Особенности Docker Desktop на macOS

1. **`host.docker.internal`** работает из коробки. `extra_hosts: host-gateway` добавлен для Linux, на Mac он безвреден. На Linux приложения, слушающие только `127.0.0.1`, из контейнеров не видны — нужен `0.0.0.0` или IP моста.
2. **cAdvisor на Mac** показывает Linux-ВМ Docker Desktop, а не macOS; монтировать `/cgroup` нельзя (так сделано в [dockprom](https://github.com/stefanprodan/dockprom)). В Docker 29 образы по умолчанию хранит containerd, и cAdvisor в режиме containerd не видит контейнеры без `--containerd-namespace=moby` ([разбор](https://lucaberton.com/blog/docker-29-cadvisor-containerd-namespace-fix/)). В режиме docker.sock работает, но метки контейнеров могут пропадать. Поэтому cAdvisor вынесен в профиль `monitoring-host`, основное назначение — прод на Linux. **На этой машине не проверено.**
3. **node-exporter на Mac** бесполезен: он тоже покажет ВМ, а монтирование `/:/host:ro,rslave` на Docker Desktop может не заработать. На Linux-ВМ ставить на хост.
4. **Порты.** Docker Desktop по умолчанию публикует на все интерфейсы, отсюда префикс `127.0.0.1:` во всех фрагментах. Отдельный порт метрик LiteLLM (4001) и раннер (9101) — без авторизации, их не публикуем.
5. **Память.** Prometheus, Grafana и два экспортёра займут примерно 300–500 МБ (оценка, не замер). Это ещё один довод за профиль.
6. **Конфиги** монтируются из `/Users/...`: на Mac эта папка доступна Docker по умолчанию. После правки `prometheus.yml` выполнить `curl -X POST localhost:9090/-/reload`.
7. **Метрики самого Docker** дают только данные движка: `"metrics-addr": "127.0.0.1:9323"` в настройках Docker Engine, пометка «в активной разработке» ([docs](https://docs.docker.com/engine/daemon/prometheus/)).

## 4. Ошибки в текущем compose, которые заметил попутно

- `gitea/act_runner:latest` отдаёт устаревший образ 0.6.1. Заменить на `gitea/runner:4.0.0`. Имейте в виду несовместимые изменения 4.0.0:
  - звёздочка `*` в `valid_volumes` больше не проходит через `/`;
  - задачи с `container.network: bridge` не достучатся до кэша.
- **Не проверено:** Gitea отдаёт задачам `ROOT_URL=http://localhost:3300/`. Внутри контейнера задачи `localhost` — это сам контейнер, поэтому checkout в Actions может падать. Лечится `ROOT_URL`, доступным из сети задач, или встроенным `builtin:checkout` из runner 4.0.0.
- `main-stable` и все `latest` — плавающие теги. Прошу закрепить хотя бы версии, а LiteLLM — и по digest.
- Раннер использует `node:22-bookworm`. Это нужно выровнять с решением «Node — максимальная».

## 5. В чём я не уверен

- Суффикс `_total` у счётчиков LiteLLM и допустимость имён в `prometheus_exclude_labels` — проверить по `/metrics` и логу старта.
- Работу `CONFIG_FILE` в раннере с частичным YAML (остальные поля по умолчанию). В исходниках не проверял, только пример конфига.
- Что файловое provisioning в Grafana 13.2.2 без проблем берёт классический JSON. Issue закрыто, но в какой версии исправлено, не видно.
- cAdvisor на Docker Desktop и доступность grafana.com и Docker Hub с российских ВМ — не проверял.
- Префикс `vault_*` у метрик OpenBao взят из документации OpenBao, а не из реального ответа.

**Источники** (кроме ссылок в тексте):
- теги Docker Hub: `https://hub.docker.com/v2/repositories/<ns>/<repo>/tags?ordering=last_updated`;
- теги GHCR: `https://ghcr.io/v2/<repo>/tags/list`;
- теги quay.io: [postgres-exporter](https://quay.io/repository/prometheuscommunity/postgres-exporter?tab=tags);
- `npm view` для prom-client, @willsoto/nestjs-prometheus, @nestjs/core и next;
- [defaults.ini Grafana 13.2.2](https://github.com/grafana/grafana/blob/v13.2.2/conf/defaults.ini);
- [README runner](https://gitea.com/gitea/runner/src/branch/main/README.md);
- [Next.js: инструментирование](https://nextjs.org/docs/app/guides/instrumentation).