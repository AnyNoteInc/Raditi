# Нужен ли Радити Redis: что его заменит

## Коротко

Redis не нужен. Всё, для чего его планировали, закрывает PostgreSQL 17, который в стеке уже есть.

- **Основной вариант — DBOS Transact.** Это библиотека `@dbos-inc/dbos-sdk` 5.1.10 (MIT), она работает внутри NestJS-бэкенда. Даёт очереди с лимитом «по одной задаче на сайт», устойчивые workflow, ожидание сигналов с таймаутом, отмену, cron и потоки событий. Хранит всё в той же базе, что и данные платформы.
- **Запасной вариант — pg-boss 12.34.0** (MIT) при том же дизайне.
- **Главное правило дизайна.** Истина о задаче — строка `tasks.status`. Workflow короткие, до часа. Ожидание клиента в течение дней — это статус задачи плюс отложенный таймер-workflow, а не workflow, который висит днями. Так почти исчезает главная ловушка устойчивых workflow: смена кода при выкладке платформы, пока старые экземпляры ещё не завершились.
- **Попутная находка.** В `infra/dev/docker-compose.yml` стоит `redis:7-alpine`, сейчас это 7.4.9. Redis 7.4 распространяется под RSALv2/SSPLv1, то есть уже не открытая лицензия. Если Redis где-то останется, берём `valkey/valkey:9.1-alpine` (BSD-3).

---

## 1. Для чего планировали Redis и чем это закрыть

| # | Потребность | Где возникает | Чем закрыть без Redis |
|---|---|---|---|
| 1 | Очередь задач: web ставит, бэкенд выполняет; приоритет; общий лимит песочниц по ресурсам VM | §5, §7 | Очереди DBOS: `globalConcurrency`, `priority` |
| 2 | Устойчивый многошаговый цикл задачи: подготовка → ход агента → push и PR → проверки → «Применить» → merge → выкладка → проверка → списание | §7 | Короткие workflow DBOS плюс статусы в `tasks` |
| 3 | Ожидание клиента часами и днями (`awaiting_user`, `awaiting_approval`) | §7 | Статус и отложенный таймер: `enqueueOptions.delaySeconds` |
| 4 | Ожидание вебхуков: проверки PR, `workflow_run` при выкладке; от Gitea, а теперь и от GitHub/GitLab | §10 | `DBOS.recv(topic, {timeoutSeconds})` в workflow, `DBOSClient.send(..., idempotencyKey)` из web |
| 5 | По одному на сайт: ходы агента и выкладки строго по очереди. На `concurrency` Gitea полагаться нельзя, раз сайты бывают на GitHub/GitLab | §10 | Партиционированные очереди: `partitionConcurrency: 1`, `queuePartitionKey: siteId` |
| 6 | Повторы с нарастающей паузой и идемпотентность (LLM, Gitea API, S3) | — | `runStep({retriesAllowed, maxAttempts, backoffRate})`, детерминированные `workflowID` |
| 7 | Таймауты: 20 минут на ход, ожидание проверок и выкладки | §8 | Шаг с `timeoutMS` и `DBOS.stepStatus.timeoutSignal`, чтобы остановить контейнер; `recv` с таймаутом |
| 8 | Отмена: убить контейнер, вернуть квоту | §7, §17 | `cancelWorkflow` → `stepStatus.cancelSignal`; возврат делает отдельный workflow |
| 9 | Cron: продление подписок, уведомления, очистка, 7 дней на «Отменить», уборка зависших задач, сверка расходов LiteLLM | §6, §17 | Расписания DBOS в базе: `DBOS.applySchedules`, `cronTimezone` |
| 10 | Раздача событий SSE по репликам web | §5 | Таблица `task_events` плюс LISTEN/NOTIFY (раздел 5) |
| 11 | Распределённые блокировки | §5 («очереди и блокировки») | Партиции DBOS; `pg_advisory_xact_lock`; условный `UPDATE … WHERE status IN (…)` |
| 12 | Ограничение частоты запросов: вход, чат, вебхуки | — | better-auth `rateLimit.storage: "database"` ([docs](https://www.better-auth.com/docs/concepts/rate-limit)); rateLimit в Traefik на входе; квоты `credit_ledger` |
| 13 | Кэш: цены моделей, тарифы, сессии | — | LRU в памяти процесса с коротким TTL; Next.js cache на каждом экземпляре |
| 14 | better-auth secondaryStorage | — | Не нужен: он необязателен ([docs](https://www.better-auth.com/docs/concepts/database)), сессии живут в PostgreSQL, плюс `session.cookieCache` |
| 15 | LiteLLM | §9 | Для одного экземпляра Redis не нужен. При нескольких нужен, чтобы делить счётчики TPM/RPM, состояние роутера и кэш ([docs](https://docs.litellm.ai/docs/proxy/prod)). Наша нагрузка — десятки параллельных ходов — укладывается в один экземпляр с `--num_workers 1` |
| 16 | Дедупликация вебхуков: Telegram `update_id`, ЮKassa, Gitea delivery | — | Уникальные ограничения в PostgreSQL; `idempotencyKey` у `send` |

Не проверено: делят ли счётчики лимитов несколько uvicorn-воркеров внутри одного контейнера LiteLLM. Документация говорит только про экземпляры. Поэтому держим один воркер.

---

## 2. Сравнение

Загрузки npm — за последнюю неделю по api.npmjs.org на 2026-09-26, звёзды — через `gh api`.

| Вариант | Лицензия | Что добавляется в инфраструктуру | Зрелость | TS и NestJS | Атомарность с Prisma 7 | Ожидание днями, сигналы | Лимит на ключ (сайт) | Cron / отмена | Код меняется, а экземпляры не завершились | UI без чужого SaaS |
|---|---|---|---|---|---|---|---|---|---|---|
| **(a) Valkey/Redis + BullMQ 6.3.9** | MIT; Valkey BSD-3; Redis 8 — RSALv2/SSPLv1/AGPLv3 | Valkey (+ бэкапы, HA) | 7,8 млн/нед, ★9,4k | `@nestjs/bullmq` 12.0.0 (есть Nest 12) | Нет: Redis и PG — две записи, нужен outbox | Нет устойчивых ожиданий, только своя машина состояний | Группы — только в платном BullMQ Pro ([docs](https://docs.bullmq.io/bullmq-pro/groups/concurrency)) | Job schedulers / сами | Проблемы нет: задачи короткие | Bull Board (MIT) |
| **(b1) DBOS Transact 5.1.10** | MIT | Ничего: таблицы в схеме `dbos` того же PG | 287k/нед, ★1,4k. Мажор 5.0 вышел 2026-09-16 | Библиотека; Nest через `ConfiguredInstance` ([docs](https://docs.dbos.dev/integrations/nestjs)) или функциональный API; от версии Nest не зависит | **Да:** `PrismaDataSource.runTransaction` пишет чекпоинт в той же транзакции; `enqueueInTransaction(pgClient)` | `recv`/`send` с таймаутом, `setEvent`, `delaySeconds` | `partitionConcurrency` | Расписания в БД; `cancelWorkflow` + `cancelSignal` | Версия = хеш кода; есть `enablePatching` + `DBOS.patch()` ([docs](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)) | Conductor — проприетарный; self-host только на Enterprise ([pricing](https://www.dbos.dev/dbos-pricing), [docs](https://docs.dbos.dev/production/hosting-conductor)). Бесплатно — CLI `dbos workflow list/cancel/resume/fork` и своя админка |
| **(b2) pg-boss 12.34.0** | MIT | Ничего: схема `pgboss` | 1,71 млн/нед, ★4,0k, с 2016 года | `@wavezync/nestjs-pgboss` 7.0.2 (Nest 12) | Постановка в очередь — да: `send(..., {db: fromPrisma(tx)})`. Выполнение — хотя бы раз | Нет, только своя машина состояний + `startAfter` | `groupConcurrency` глобально по узлам, `key_strict_fifo` ([docs](https://pgboss.io/api/workers)) | cron/RRULE, dead letter; отмена — `cancel` + своя логика | Проблемы нет | `@pg-boss/dashboard` 1.9.0 (MIT) |
| **(b3) graphile-worker 0.18.0** | MIT | Ничего | 544k/нед, ★2,4k | Только ESM, Node ≥22.18; модуля для Nest нет | Постановка — да: `SELECT graphile_worker.add_job()` в `$executeRaw` | Нет | `queue_name` выполняет задачи по одной | crontab | Проблемы нет | Нет |
| **(c1) Temporal** (server v1.32.0, TS SDK 1.24.0) | MIT | 4 сервиса (frontend/history/matching/worker) + PG для данных и поиска + UI | 3,65 млн/нед, ★23,3k — самый зрелый | Workflow идут в изолированном V8, Prisma там нельзя; `nestjs-temporal-core` 3.4.0 только до Nest 11 | Нет: activity должны быть идемпотентными, запуск через outbox | Отличные signals/updates/`condition` | Нет; fairness keys ограничивают частоту, а не параллельность ([docs](https://docs.temporal.io/develop/task-queue-priority-fairness)) | Schedules / cancel | `patched()` + Worker Versioning; есть replay-тесты в CI | Temporal UI (MIT) |
| **(c2) Restate** (server v1.7.12, SDK 1.17.2) | Сервер BSL 1.1 (внутреннее использование разрешено, через 4 года — Apache-2.0) ([LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)) | Отдельный stateful-сервер (RocksDB + снапшоты) | 204k/нед, ★4,5k | SDK MIT | Нет | Awakeables и durable promises | Virtual Objects — ровно одна обработка на ключ | Есть | Незавершённые вызовы привязаны к выкладке: старую держать до конца ([docs](https://docs.restate.dev/operate/versioning)) | Встроенный |
| **(c3) Hatchet** (engine v0.107.x, SDK 1.33.2) | MIT | Go-движок + свой PG, RabbitMQ опционально | 448k/нед, ★8,0k | SDK есть, модуля для Nest нет | Нет | `ctx.waitFor(Or(sleepFor, event))` | `concurrency.expression` + `maxRuns` ([docs](https://docs.hatchet.run/v1/concurrency)) | Есть | Replay по журналу событий; описано хуже, детально не проверял | Встроенный (MIT) |
| **(c4) Inngest self-hosted** (SDK 4.21.0) | Сервер SSPL + DOSP → Apache через 3 года — **флаг** | В проде нужен **Redis** + PG ([docs](https://www.inngest.com/docs/self-hosting)) | 1,79 млн/нед, ★5,9k | SDK Apache-2.0 | Нет | `waitForEvent` | Ключи concurrency | Есть | Есть | Есть |
| **(c5) Trigger.dev self-hosted** (SDK 4.6.4) | Apache-2.0 | PG + **Redis** + Electric + ClickHouse + MinIO + registry + supervisor, от 7 vCPU ([docs](https://trigger.dev/docs/self-hosting/docker)) | 937k/нед, ★16,4k | Задачи идут в **его** контейнерах — дублирует нашу песочницу | Нет | Waitpoints; но в self-host **нет чекпоинтов** для неблокирующих ожиданий ([docs](https://trigger.dev/docs/self-hosting/overview)) | `concurrencyKey` | Есть | Есть | Есть |
| **(d) NATS JetStream** (server v2.15.0) | Apache-2.0 | Кластер NATS (3 узла для HA) | CNCF, зрелый | `@nats-io/jetstream` 3.4.0 | Нет, двойная запись | Нет, это шина | Через subjects/consumers, вручную | Нет | — | Нет |

Итог:
- (c4) и (c5) не избавляют от Redis.
- (c1) и (c3) означают отдельный сервер. При ~30 тыс. задач в месяц (~1000 в день) это избыточно.
- (d) — шина, а не движок workflow.

---

## 3. Рекомендация

### Основной вариант: DBOS Transact 5.1.x внутри объединённого NestJS-бэкенда

Системные таблицы DBOS — в той же базе PostgreSQL 17, в схеме `dbos`, вне `public`. Тогда Prisma migrate их не трогает. Сервисов не добавляется, а один бэкап PostgreSQL покрывает и бизнес-данные, и состояние workflow.

Правила дизайна:

1. **Истина — `tasks.status`.** Переход статуса и операция с `credit_ledger` идут одной транзакцией `PrismaDataSource.runTransaction` с условным `updateMany`. Так списание или возврат выполняется ровно один раз.
2. **Workflow короткие.**
   - `turn` — один ход, до 20 минут плюс ожидание проверок до 20 минут.
   - `apply` — merge и выкладка, до 45 минут.
   - `expireWait` — отложенный таймер.
   - `cancelTask` — отмена.
   
   Ожидание клиента днями — это статус, а не висящий workflow. Иначе каждая выкладка платформы воспроизводила бы сотни ожидающих workflow по чекпоинтам. Ещё хуже при версии по умолчанию (хеш кода): восстановление фильтрует по `application_version`, и после выкладки старые ожидания не восстановятся вовсе. Это видно в `getPendingWorkflows`: `WHERE status=$1 AND executor_id=$2 AND application_version=$3`.
3. **Конфигурация.**
   - `enablePatching: true`: версия становится константой `PATCHING_ENABLED`, несовместимые правки короткого workflow идут через `DBOS.patch()`.
   - Стабильный `DBOS__VMID` (например, `backend-1`). Без Conductor упавший экземпляр восстанавливает только свои workflow ([docs](https://docs.dbos.dev/production/workflow-recovery)).
   - Начинаем с одной реплики, которая выполняет workflow. Реплики MCP-шлюза того же образа поднимаем с `listenQueues: []`, чтобы они не забирали задачи.
4. **Очереди.**
   - `agent`: `partitionConcurrency: 1` по `siteId`, `globalConcurrency` = числу слотов песочниц.
   - `apply`: `partitionConcurrency: 1` по `siteId`. Выкладки сериализуются для любого git-провайдера, а не только для Gitea.
   - `timers`, `control`.
5. **Порт в домене.** Вы решили делать порты и адаптеры. `packages/domain` объявляет порт `TaskRuntime`: `enqueueTurn`, `approve`, `signal`, `cancel`. Адаптер DBOS — отдельный пакет. Тогда переход на pg-boss стоит дёшево.
6. **Наблюдаемость.**
   - Страница «Процессы» в админке оператора через `DBOSClient.listWorkflows` / `listWorkflowSteps`.
   - CLI `dbos workflow cancel|resume|fork`.
   - Метрики для Prometheus/Grafana: запросы postgres_exporter к `dbos.workflow_status` и `tasks` (глубина очередей, возраст). Алерт «в очереди дольше 10 минут» из §19.
   - Трейсы — `@dbos-inc/otel` 5.1.10, если позже поднимем Tempo.

### Запасной вариант: pg-boss 12.34.0 при том же дизайне

- Статусы в `tasks`.
- Каждый переход — задача pg-boss, поставленная в той же Prisma-транзакции (`fromPrisma(tx)`).
- По одному на сайт: `groupConcurrency: 1` с `group: {id: siteId}`.
- Таймеры — `startAfter`, cron встроенный, UI — `@pg-boss/dashboard`.
- Шагов с чекпоинтами нет: внутри хода идемпотентность пишем сами.

Если понадобится отдельный движок с UI, следующий кандидат — Hatchet (MIT).

### Что теряем по сравнению с Redis и BullMQ

- **Задержку и пропускную способность.** Задача в очереди подхватывается за единицы или сотни миллисекунд (опрос раз в секунду, NOTIFY) вместо единиц миллисекунд. На нашей нагрузке это неважно.
- **Экосистему BullMQ:** официальный `@nestjs/bullmq`, огромное сообщество. У DBOS модуля для Nest нет, интеграция ручная, и нужна дисциплина детерминизма: workflow-код только оркестрирует, логика — в шагах.
- **Бесплатную готовую UI.** У DBOS она платная (Conductor), значит свою админку придётся писать.
- **Эфемерный pub/sub и KV с TTL без записи на диск.** Замена — `pg_notify` без записи в таблицу для эфемерных дельт и UNLOGGED-таблицы для счётчиков.
- **Готовое общее хранилище для LiteLLM**, если его придётся масштабировать. Тогда добавим Valkey 9.1 (BSD-3) только для LiteLLM, без персистентности.

---

## 4. Набросок жизненного цикла (DBOS 5.1.x)

```ts
// apps/backend/src/tasks/task-workflows.ts
import { DBOS } from '@dbos-inc/dbos-sdk'
import { PrismaDataSource } from '@dbos-inc/prisma-datasource'
import { prisma, type PrismaClient, type TaskStatus } from '@repo/db'
import { sandbox, git, notify, events } from './adapters' // SandboxRunner, GitProvider, Notifier, TaskEvents

const db = new PrismaDataSource<PrismaClient>('app', prisma)
const H = 3600
const PRE_DEPLOY: TaskStatus[] = ['queued', 'preparing', 'running', 'awaiting_user', 'awaiting_approval']

// Status transition + ledger in ONE Prisma transaction, checkpointed by DBOS (exactly-once).
// Conditional UPDATE: if the task was cancelled/expired meanwhile, nothing happens.
const transition = (taskId: string, from: TaskStatus[], to: TaskStatus,
                    ledger?: 'charge' | 'refund', turnNo?: number) =>
  db.runTransaction(async () => {
    const { count } = await db.client.task.updateMany({
      where: { id: taskId, status: { in: from }, ...(turnNo ? { turnNo } : {}) },
      data: { status: to },
    })
    if (count === 1 && ledger) await db.client.creditLedger.create({ data: { taskId, kind: ledger } })
    return count === 1
  }, { name: `to_${to}` })

const scheduleExpiry = (taskId: string, status: TaskStatus, turnNo: number, delaySeconds: number) =>
  DBOS.startWorkflow(expireWaitWf, {
    queueName: 'timers', workflowID: `expire:${taskId}:${turnNo}`, enqueueOptions: { delaySeconds },
  })(taskId, status, turnNo)

// One agent turn. Queue 'agent', partition = siteId, workflowID = `turn:${taskId}:${turnNo}`
async function turn(taskId: string, turnNo: number) {
  if (!(await transition(taskId, ['queued'], 'preparing'))) return // cancelled while queued
  const run = await DBOS.runStep(() => sandbox.prepare(taskId, turnNo), // session from S3, clone, LLM key
    { name: 'prepare', retriesAllowed: true, maxAttempts: 3 })
  await transition(taskId, ['preparing'], 'running')

  let out: Awaited<ReturnType<typeof sandbox.runTurn>>
  try {
    out = await DBOS.runStep(async () => {
      const s = DBOS.stepStatus!
      const kill = () => void sandbox.kill(run.id)            // cancel or 20-min timeout -> docker kill
      s.cancelSignal.addEventListener('abort', kill)
      s.timeoutSignal?.addEventListener('abort', kill)
      // runTurn always saves session to S3 and destroys the container
      return sandbox.runTurn(run, { onEvent: (e) => events.append(taskId, turnNo, e) })
    }, { name: 'agentTurn', timeoutMS: 20 * 60_000 })
  } catch {
    await transition(taskId, ['running'], 'failed', 'refund')
    return
  }

  if (out.kind === 'question') {
    if (await transition(taskId, ['running'], 'awaiting_user')) await scheduleExpiry(taskId, 'awaiting_user', turnNo, 72 * H)
    return
  }
  if (out.kind === 'content_only') { await transition(taskId, ['running'], 'done', 'charge'); return }

  await DBOS.runStep(() => git.pushAndOpenPr(taskId, out.branch), { name: 'pr', retriesAllowed: true })
  const ci = await DBOS.recv<{ ok: boolean }>('ci', { timeoutSeconds: 20 * 60 }) // webhook -> web -> DBOSClient.send
  if (!ci?.ok) { await transition(taskId, ['running'], 'failed', 'refund'); return } // or: new turn with CI log
  if (await transition(taskId, ['running'], 'awaiting_approval')) await scheduleExpiry(taskId, 'awaiting_approval', turnNo, 7 * 24 * H)
}
export const turnWf = DBOS.registerWorkflow(turn, { name: 'turn' })

// "Применить". Queue 'apply', partition = siteId, workflowID = `apply:${taskId}` (double click = same workflow)
async function apply(taskId: string) {
  if (!(await transition(taskId, ['awaiting_approval'], 'deploying'))) return
  const d = await DBOS.runStep(() => git.putDeploySecretAndMerge(taskId), { name: 'merge', retriesAllowed: true })
  let ev: { stage: 'verifying' | 'success' | 'rolled_back' | 'failed' } | null
  do {
    ev = await DBOS.recv('deploy', { timeoutSeconds: 45 * 60 })
    if (ev?.stage === 'verifying') await transition(taskId, ['deploying'], 'verifying')
  } while (ev?.stage === 'verifying')
  await DBOS.runStep(() => git.revokeDeploySecret(d), { name: 'revoke', retriesAllowed: true })
  if (ev?.stage === 'success') await transition(taskId, ['deploying', 'verifying'], 'done', 'charge')
  else if (ev?.stage === 'rolled_back') await transition(taskId, ['deploying', 'verifying'], 'rolled_back', 'refund') // open question
  else await DBOS.runStep(() => notify.operator(taskId, 'deploy_unknown'), { name: 'escalate' }) // prod may have changed
}
export const applyWf = DBOS.registerWorkflow(apply, { name: 'apply' })

// Delayed timer: no-op if the task has moved on or a new turn started
async function expireWait(taskId: string, status: TaskStatus, turnNo: number) {
  if (await transition(taskId, [status], 'cancelled', 'refund', turnNo))
    await DBOS.runStep(() => notify.expired(taskId), { name: 'notify' })
}
export const expireWaitWf = DBOS.registerWorkflow(expireWait, { name: 'expireWait' })

// Client cancel (only before deploy). workflowID = `cancel:${taskId}`
async function cancelTask(taskId: string) {
  if (!(await transition(taskId, PRE_DEPLOY, 'cancelled', 'refund'))) return // deploying/done: too late
  const { turnNo } = await DBOS.runStep(() => prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { turnNo: true } }), { name: 'load' })
  await DBOS.runStep(() => DBOS.cancelWorkflow(`turn:${taskId}:${turnNo}`), { name: 'cancelTurn' }) // -> cancelSignal -> kill
}
export const cancelTaskWf = DBOS.registerWorkflow(cancelTask, { name: 'cancelTask' })

// main.ts: registerWorkflow before launch; queues and schedules after it
DBOS.setConfig({ name: 'raditi', systemDatabaseUrl: process.env.DATABASE_URL!, enablePatching: true })
await DBOS.launch()
await DBOS.registerQueue('agent', { partitionConcurrency: 1, globalConcurrency: Number(process.env.SANDBOX_SLOTS) })
await DBOS.registerQueue('apply', { partitionConcurrency: 1 })
await DBOS.registerQueue('timers'); await DBOS.registerQueue('control')
await DBOS.applySchedules([{ scheduleName: 'reaper', workflowFn: reaperWf, schedule: '*/5 * * * *' },
  { scheduleName: 'renewals', workflowFn: renewalsWf, schedule: '0 6 * * *', cronTimezone: 'Europe/Moscow' }])
```

```ts
// apps/web: only DBOSClient, no workflow code here
const dbos = await DBOSClient.create({ systemDatabaseUrl: env.DATABASE_URL, applicationName: 'raditi' })
// new task: Prisma tx (task=queued + reserve) -> enqueue with deterministic ID (idempotent);
// if enqueue fails after commit, the reaper re-enqueues orphaned 'queued' tasks
await dbos.enqueue({ queueName: 'agent', workflowName: 'turn', workflowID: `turn:${t.id}:1`, queuePartitionKey: t.siteId }, t.id, 1)
// client answer: guarded awaiting_user -> queued, turnNo+1, then enqueue `turn:${id}:${n+1}` (old timer becomes no-op)
await dbos.enqueue({ queueName: 'apply', workflowName: 'apply', workflowID: `apply:${id}`, queuePartitionKey: siteId }, id)
await dbos.send(`apply:${id}`, { stage }, 'deploy', deliveryId)   // Gitea/GitHub/GitLab webhook after signature check
await dbos.enqueue({ queueName: 'control', workflowName: 'cancelTask', workflowID: `cancel:${id}` }, id)
```

Сроки 72 часа и 7 дней — заглушки, их нужно утвердить.

**Для вас — открытый вопрос:** при `rolled_back` квоту возвращать или списывать? В §17 сказано только про `done`, `failed` и `cancelled`.

---

## 5. SSE без Redis

1. **Источник правды — таблица `task_events`.** Поля: `id bigserial`, `task_id`, `turn_no`, `type`, `payload jsonb`, `client_visible`, `created_at`, индекс `(task_id, id)`. Большие данные (дифф, лог) кладём в S3, в событии — ссылка. История чата всё равно нужна навсегда, поэтому потоки DBOS (`writeStream`/`readStream` — тоже PostgreSQL и LISTEN/NOTIFY) подходят только для эфемерного.
2. **Писатель — только бэкенд.** Он разбирает JSONL драйвера, копит события 200–500 мс и одной транзакцией делает `INSERT … ; SELECT pg_notify('task_events', task_id)`. В payload только id задачи: у NOTIFY лимит 8000 байт. Эфемерные токен-дельты можно слать одним `pg_notify` без записи в таблицу.
3. **Каждая реплика web держит одно отдельное `pg.Client` с `LISTEN task_events`** и карту в памяти `taskId → Set<контроллер SSE>`. На уведомление — один запрос `WHERE task_id=$1 AND id > $lastSent` на задачу на реплику и рассылка подписчикам. Привязка клиента к реплике (sticky) не нужна.
4. **Route handler** `app/api/tasks/[id]/events` (`runtime='nodejs'`, `dynamic='force-dynamic'`):
   - права проверяются при подключении;
   - у каждого события `id:` = `task_events.id`, плюс `retry: 3000`;
   - `: ping` раз в 15–20 секунд — от таймаутов Traefik;
   - при переподключении по `Last-Event-ID` досылаем пропущенное из базы.
   
   Если LISTEN-соединение отвалилось — переподключаемся и досчитываем каждую активную задачу из базы. Страховка — опрос раз в 5 секунд.
5. **LISTEN не работает через пулер в режиме транзакций.** В Yandex Managed PostgreSQL это пулер Odyssey. Нужен пользователь в session-режиме или прямое подключение ([Yandex Cloud docs](https://yandex.cloud/en/docs/managed-postgresql/concepts/pooling)).
6. **Объём.** ~30 тыс. задач × ~150 событий ≈ 4,5 млн строк в месяц, в среднем ~2 вставки в секунду. Порог, где глобальная блокировка NOTIFY при COMMIT становится проблемой, — ~2,9 тыс. записей в секунду ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale), [DBOS](https://www.dbos.dev/blog/postgres-listen-notify-scalability)). Технические события чистим по сроку или партициям; сырые JSONL уже лежат в `raditi-logs`.

---

## 6. Риски, версии, источники

**Риски DBOS и что с ними делать:**
- **Мажор 5.0 свежий** (2026-09-16): схему переделали, входы и выходы вынесли в отдельные таблицы ([releases](https://github.com/dbos-inc/dbos-transact-ts/releases)). Закрепить точную версию 5.1.10 и следить за 5.1.x.
- **`@dbos-inc/prisma-datasource` в репозитории тестируют на Prisma 5.15** (devDependencies). С Prisma 7 и `PrismaPg` связку проверить спайком. Интерфейс утиный: `$transaction`, `$queryRawUnsafe`.
- **Сериализация — SuperJSON.** `Prisma.Decimal` (вы решили хранить деньги в decimal) без `registerSerializationRecipe` не восстановится. Из шагов и транзакций возвращать DTO, деньги — строкой.
- **Бесплатной self-hosted UI нет.** Conductor на своих серверах — только тариф Enterprise; облачный Conductor — зарубежный SaaS, по 152-ФЗ исключён. Какие данные через него проходят, я не проверял.
- **Нет аналога replay-тестов Temporal.** Workflow-код держать тонким, логику — в шагах; несовместимые правки — через `DBOS.patch()`.
- **Восстановление без Conductor** требует стабильного `DBOS__VMID` на каждый экземпляр.
- **PostgreSQL становится единой точкой отказа для всего.** Он ею и так был; нужен PITR.

**Прочие риски:**
- `redis:7-alpine` в dev-compose — RSALv2/SSPLv1 ([redis.io/legal/licenses](https://redis.io/legal/licenses/)).
- NestJS 12.1.0 уже вышел (12.0.0 — 2026-08-27), а в CLAUDE.md записан 11. `nestjs-temporal-core` 3.4.0 не поддерживает Nest 12 — ещё один минус Temporal.
- Prisma 8 в RC (`8.0.0-rc.17`), стабильная — 7.10.0.

**Версии и лицензии** (npm, 2026-09-26):

| Пакет / сервис | Версия | Лицензия |
|---|---|---|
| `@dbos-inc/dbos-sdk`, `@dbos-inc/prisma-datasource`, `@dbos-inc/otel` | 5.1.10 | MIT |
| `pg-boss` / `@pg-boss/dashboard` / `@wavezync/nestjs-pgboss` | 12.34.0 / 1.9.0 / 7.0.2 | MIT |
| `graphile-worker` | 0.18.0 | MIT |
| `bullmq` / `@nestjs/bullmq` | 6.3.9 / 12.0.0 | MIT |
| `@temporalio/*` / Temporal server | 1.24.0 / v1.32.0 | MIT |
| `@restatedev/restate-sdk` / Restate server | 1.17.2 / v1.7.12 | SDK MIT; сервер BSL 1.1 |
| `@hatchet-dev/typescript-sdk` / Hatchet engine | 1.33.2 / v0.107.x | MIT |
| `inngest` / Inngest server | 4.21.0 | SDK Apache-2.0; сервер SSPL + DOSP |
| `@trigger.dev/sdk` | 4.6.4 | MIT (репозиторий Apache-2.0) |
| `@nats-io/jetstream` / nats-server | 3.4.0 / v2.15.0 | Apache-2.0 |
| Valkey | 9.1.2 (есть `9.2.0-rc1`) | BSD-3 |
| `better-auth` | 1.7.6 | MIT |
| `@prisma/client` | 7.10.0 | Apache-2.0 |
| `@nestjs/core` | 12.1.0 | MIT |

**Что обновить в документах, если решение примете** (файлы я не менял):
- `docs/spec.md`: строка 27, диаграмма §5 (строка 130), таблицы §5/§6 (строки 140, 147), §19 (строка 643);
- `CLAUDE.md`: разделы «Стек» и «Команды»;
- `.env.example`: `REDIS_URL`;
- `infra/dev/docker-compose.yml`: сервис `redis`;
- `docs/plan/00-bootstrap.md`: строки 20, 21, 46, 47, 53;
- `docs/plan/roadmap.md`: B5, health-проверки «Redis».

**Источники:**
- DBOS: [queues](https://docs.dbos.dev/typescript/tutorials/queue-tutorial), [workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication), [upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows), [recovery](https://docs.dbos.dev/production/workflow-recovery), [NestJS](https://docs.dbos.dev/integrations/nestjs), [Conductor self-host](https://docs.dbos.dev/production/hosting-conductor), [pricing](https://www.dbos.dev/dbos-pricing). Кроме того, я прочитал исходники пакетов 5.1.10: `dbos.d.ts`, `client.d.ts`, `step.d.ts`, `system_database.js`, `prisma-datasource/index.ts`.
- pg-boss: [pgboss.io workers](https://pgboss.io/api/workers), [releases](https://github.com/timgit/pg-boss/releases), README пакета 12.34.0.
- graphile-worker: [docs](https://worker.graphile.org/docs), [release notes](https://github.com/graphile/worker/blob/main/RELEASE_NOTES.md).
- Temporal: [releases](https://github.com/temporalio/temporal/releases), [fairness](https://docs.temporal.io/develop/task-queue-priority-fairness).
- Restate: [releases](https://github.com/restatedev/restate/releases), [LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE), [versioning](https://docs.restate.dev/operate/versioning).
- Hatchet: [self-hosting](https://docs.hatchet.run/self-hosting), [releases](https://github.com/hatchet-dev/hatchet/releases).
- Inngest: [self-hosting](https://www.inngest.com/docs/self-hosting), [блог 1.0](https://www.inngest.com/blog/inngest-1-0-announcing-self-hosting-support).
- Trigger.dev: [overview](https://trigger.dev/docs/self-hosting/overview), [docker](https://trigger.dev/docs/self-hosting/docker).
- BullMQ Pro groups: [docs](https://docs.bullmq.io/bullmq-pro/groups/concurrency).
- LiteLLM: [prod](https://docs.litellm.ai/docs/proxy/prod).
- better-auth: [database](https://www.better-auth.com/docs/concepts/database), [rate-limit](https://www.better-auth.com/docs/concepts/rate-limit).
- Лицензии Redis: [redis.io](https://redis.io/legal/licenses/). Valkey: [releases](https://github.com/valkey-io/valkey/releases).
- NATS: [releases](https://github.com/nats-io/nats-server/releases).
- LISTEN/NOTIFY: [Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale), [DBOS](https://www.dbos.dev/blog/postgres-listen-notify-scalability).
- Пулер Yandex: [docs](https://yandex.cloud/en/docs/managed-postgresql/concepts/pooling).

Исходники пакетов, которые я разбирал, лежат в `<scratchpad>/`: `dbos-inc-dbos-sdk-5.1.10`, `dbos-inc-prisma-datasource-5.1.10`, `pgboss`.