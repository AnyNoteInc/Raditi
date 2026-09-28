# Исследования к /bootstrap, 26.09.2026

> **Исторические документы, не правятся.** Решение владельца от 28.09.2026 перевело доступ к моделям на подписки Codex и Kimi через шлюз подписок: LiteLLM, российские провайдеры моделей (Yandex AI Studio, Cloud.ru) и GigaChat уходят. Поэтому устарели части о LiteLLM и ценах токенов российских провайдеров: `billing.md` §1–2 (расчёт по журналу LiteLLM), `monitoring.md` (образ и метрики LiteLLM), `sandbox.md` и `sandbox-critique.md` (LiteLLM как выход песочницы и его CVE), `queue.md` и `queue-critique.md` (LiteLLM в доводах о Redis). Новые исследования — [../2026-09-subscriptions/](../2026-09-subscriptions/).

Отчёты, на которых построены решения владельца от 26.09.2026. Лежат как есть, правлены только локальные пути (заменены на относительные и `<scratchpad>`); итоговые решения — в CLAUDE.md, docs/spec.md и docs/plan/. Где отчёт расходится с решениями, верны решения.

| Отчёт | О чём |
| --- | --- |
| [versions.md](versions.md) | Совместимость последних версий стека: Node 26, pnpm 12, TypeScript 7 + 6 через псевдоним, Next.js 16.3, NestJS 12, Prisma 7.10, ESLint 10, Vitest 5 |
| [queue.md](queue.md) | Нужен ли Redis: очередь, долгие ожидания, аренда сайта, cron, SSE; сравнение BullMQ, DBOS, pg-boss, Temporal и других |
| [queue-critique.md](queue-critique.md) | Разбор отчёта об очереди: ошибки в наброске жизненного цикла, замок на сайт, риски объединённого бэкенда |
| [sandbox.md](sandbox.md) | Облачное исполнение CLI-агентов: контейнер на ход, Docker + gVisor, `SandboxProvider`, снимки ходов, сеть через `sandbox-gw` |
| [sandbox-critique.md](sandbox-critique.md) | Разбор отчёта о песочнице: один контейнер на ход через exec, pull-раннер, побочные эффекты на сайте, публикация патча, LiteLLM CVE |
| [billing.md](billing.md) | Деньги в Decimal, тариф «Оплата за действие», кошелёк, расчёт по токенам через LiteLLM, схема биллинга, чеки 54-ФЗ |
| [captcha.md](captcha.md) | Yandex SmartCaptcha для better-auth 1.7: свой плагин на `hooks.before`, переменные окружения, ошибки AnyNote |
| [monitoring.md](monitoring.md) | Prometheus + Grafana в dev-compose, источники метрик сервисов, точные теги образов |

**Очередь.** Итоговое решение — Redis + BullMQ через `@nestjs/bullmq`. Отчёты `queue.md` и `queue-critique.md` рекомендовали обойтись PostgreSQL (DBOS или pg-boss), но владелец выбрал Redis ради `@nestjs/bullmq`. Из отчётов взяты принципы, которые от движка не зависят: истина о задаче — `tasks.status`, долгие ожидания — статус плюс таймер, аренда сайта в PostgreSQL, outbox, `task_events` для SSE.
