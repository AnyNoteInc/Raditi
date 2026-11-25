# План 92. Слои образов и лёгкий образ миграций (P26)

Ветка `perf/docker-layers`. Цель — сократить то, что сервер скачивает с GHCR на каждый выпуск: выкладка упиралась в ~0,4 МБ/с и потребовала 60 минут (`aa45591a`).

## Замеры до (локально, arm64, `main` 4f537afd)

| Образ | Размер | Что меняется на каждом выпуске |
|---|---|---|
| `core` | 1,45 ГБ | слой `COPY --from=prod /repo /app` — 717 МБ, из них код ~31 МБ |
| `migrate` | 2,29 ГБ | `FROM build`: все зависимости `core` с dev (1,46 ГБ) и весь `apps/core` |

Так же устроены `llm`, `mcp`, `preview`, `runner`, `browser`: один слой «зависимости + код». За месяц до 25.11.2026 — 129 выпусков и 14 изменений `pnpm-lock.yaml`: в ~90 % выпусков зависимости не меняются, а слой с ними скачивается заново.

## Что меняем

1. **Шесть образов Nest-приложений** (`apps/{core,llm,mcp,preview,runner,browser}/Dockerfile`): стадия `prod` заменяется двумя.
   - `deps` — `pnpm install --frozen-lockfile --prod` только по `out/json` (манифесты и обрезанный lockfile). Её слой меняется только с зависимостями приложения.
   - `code` — стадия `build` без `node_modules` (исходники пакетов и `dist`).
   - В `runtime` — два `COPY`: сначала `deps`, потом `code`. Раскладка `/app` прежняя (Node снимает типы только вне `node_modules`, поэтому без `pnpm deploy`).
2. **Образ `migrate`** собирается не `FROM build`, а из своего среза `turbo prune @repo/db --docker --out-dir out/db`:
   - в нём только `@repo/db`, `@repo/domain`, `@repo/typescript-config` (её JSON читает `prisma.config.ts` через `tsconfig.json`) и prod-зависимости плюс CLI Prisma;
   - `infra/app/migrate-image.mjs` переписывает манифесты среза: `prisma` и `@repo/typescript-config` переходят в `dependencies`, dev-зависимости и недостижимые пакеты workspace (`@repo/eslint-config`) уходят. Версии по-прежнему берутся из lockfile (`--no-frozen-lockfile --prefer-offline`: lockfile только сокращается, ничего не разрешается заново);
   - тоже два слоя: зависимости и код; база — чистый `NODE_IMAGE`, без pnpm. Команды compose (`node_modules/prisma/build/index.js migrate deploy` и `db seed` в `/repo/packages/db`) не меняются.
3. **Кэш сборки выпуска** (`publish-images.yml`): `type=gha` → `type=registry` в тег `buildcache` пакета каждого образа на GHCR. Без попадания в кэш BuildKit заново собирает слой зависимостей, и у него новый digest (другие mtime), поэтому разделение слоёв не сработает. Пятнадцать кэшей `mode=max` не помещаются в 10 ГБ кэша GitHub Actions. Ошибка записи кэша выпуск не роняет (`ignore-error=true`).

## Что не трогаем сейчас

- `infra/sandbox/Dockerfile`: Chromium и CLI ставятся из одного lockfile (`packages/agent-drivers/cli`). Разделение требует двух lockfile и отдельной проверки версий — это отдельная задача.
- В prod-зависимости приложений попадают prod-зависимости `@repo/eslint-config` (eslint, typescript-eslint, turbo), потому что `pnpm install --prod` ставит все проекты среза. После разделения слоёв они скачиваются только при изменении зависимостей. Убрать их — следующий шаг.

## Проверка

- `node --test infra/app/images.test.mjs infra/app/ci.test.mjs infra/app/migrate-image.test.mjs`.
- Локальная сборка `core` и `migrate` до и после: размеры слоёв; правка одной строки кода меняет только слой `code`.
- `migrate deploy` и `db seed` образа `migrate` на одноразовой PostgreSQL.
- `pnpm verify:images` (llm, mcp, preview, runner, browser, `--only core`).

## Итог

Замеры после (локально, arm64):

| Образ | Размер | Слой зависимостей | Слой кода |
|---|---|---|---|
| `core` | 1,45 ГБ (как был) | 685 МБ | 32 МБ |
| `migrate` | 0,88 ГБ (было 2,29) | 384 МБ (CLI Prisma со studio, pglite, effect) | 19 МБ |

- Правка одной строки `apps/core/src/main.ts` меняет у `core` ровно один слой — код, 32 МБ; слой зависимостей остаётся тем же blob. Раньше выкладка `core` скачивала 717 МБ, теперь ~32 МБ, пока зависимости не меняются. Так же у остальных пяти образов.
- `migrate deploy` и `db seed` (дважды, повтор идемпотентен) из нового образа `migrate` проходят на пустой PostgreSQL. Все версии пакетов образа есть в lockfile репозитория; иначе разрешился только необязательный peer `typescript` у Prisma (7.0.2 вместо 6.0.3, обе версии есть в lockfile).
- `verify:images` по `llm`, `mcp`, `preview`, `runner`, `browser`, `core` — 41 проверка, без провалов; `test:infra` — 632 теста, без провалов.
- Не проверено до выпуска: запись кэша в GHCR (`type=registry`) работает только в Actions. Первый выпуск после слияния соберёт всё заново и скачается целиком, выигрыш появится со второго.

## Открытые вопросы (из /spec-check)

- **Кэш `mode=max` на GHCR хранит стадию `pruned`** — весь исходный код из контекста сборки, без `infra`, `docs` и секретов (`.dockerignore`). Его читает любой токен с `read:packages`, в том числе токен ВМ. Раньше кэш видели только Actions. Если это неприемлемо: отдельный пакет для кэша с доступом только у CI.
- **Образ `migrate` не проверяется автоматически**: `migrate deploy` и `db seed` прогнаны вручную. Следующий шаг — добавить `migrate` в `pnpm verify:images`.
- **Проверка `--check`** сравнивает `name@version` и integrity исходного и итогового lockfile. Peer-зависимости разрешаются заново: необязательный `typescript` у Prisma — 7.0.2 вместо 6.0.3, обе версии есть в lockfile.
