# Совместимость последних стабильных версий для Радити (на 26.09.2026)

**Итог.** Почти все последние версии ставятся вместе. Оговорок три:
1. **TypeScript 7** можно использовать только как быстрый `tsc` для проверки типов. Сам пакет `typescript` в проекте должен остаться TS 6 — через псевдоним на `@typescript/typescript6`. Иначе ломаются typescript-eslint, dependency-cruiser и Nest CLI.
2. **ESLint 10** работает, если не подключать `eslint-plugin-react` и `eslint-config-next`.
3. **Prisma** нужно закрепить точной версией `prisma@7.10.0`: dist-tag `latest` у CLI указывает на 8.0.0-rc.17.

Всё основное я проверил на Node 26.5.0 и pnpm 12.6.0 в тестовом монорепозитории в scratchpad. Результаты — в §5.

## 1. Матрица

| Пакет | Рекомендуемая версия | Что меняется и на что смотреть | Риск |
|---|---|---|---|
| Node.js | **26.10.0**; в прод — после перехода 26 в LTS (28.10.2026) | Ветка Current с 05.05.2026. Corepack в Node больше не входит (начиная с 25; локально `corepack not found`). В 26 удалён `--experimental-transform-types`, `module.register()` выдаёт предупреждение об устаревании, Temporal включён по умолчанию, undici 8, V8 14.6 (ABI 147 — нативные модули пересобираются). Встроенное снятие типов понимает только стираемый синтаксис: `enum` падает (проверено). | средний до LTS |
| pnpm | **12.6.0** | Нативный бинарник на Rust (Mach-O arm64 проверен). Изменения конфигурации — в §4. | средний |
| turbo | **2.11.4** | Читает двухдокументный lockfile pnpm 12, `turbo prune` и `install --frozen-lockfile` по его результату работают (проверено). Поддерживает `devEngines.packageManager`; поле `packageManager` уберут в будущей мажорной версии. | низкий |
| typescript | `tsc` = **7.0.2**, пакет `typescript` = **6.0.x** через псевдоним (§3) | В TS 7.0 нет программного API: основной экспорт отдаёт только `version` и `versionMajorMinor` (проверено). API обещают в 7.1, срока нет. Что убрали: `baseUrl`, `moduleResolution: node10/classic`, `target: es5`, `esModuleInterop: false` и др. Нужно явно задавать `rootDir` и `types`. | средний |
| next | **16.3.6** | По умолчанию `next build` запускает `tsc` из проекта. Next находит `typescript/package.json` и берёт его bin `tsc` или `tsc\d+`, поэтому при псевдониме проверяет типы через **tsc6** (проверено по исходнику `runTypeScriptCli.js`). Next сам дописывает в tsconfig `allowJs` и `.next/dev/types`. `next lint` удалён ещё в 16.0. | низкий |
| react, react-dom, @types/react(-dom) | **19.3.0** | Peer-зависимости Next и MUI это допускают. | низкий |
| @mui/material, icons-material, material-nextjs | **9.4.0** + @emotion/react 11.14.0, styled 11.14.1, cache 11.14.0 | Есть экспорт `@mui/material-nextjs/v16-appRouter`; он повторяет v13, то есть не отличается от `v15-appRouter` из AnyNote. Сборка прошла. `@mui/lab` пока только 9.0.0-beta.9. MUI X 9.14.0 совместим с material ^9. | низкий |
| @next/mdx | **16.3.6** + @mdx-js/loader и react 3.1.1, @types/mdx 2.0.14, remark-gfm 4.0.1 | С Turbopack плагины задаются **строками**. Нужен `mdx-components.tsx`. Frontmatter по умолчанию не поддерживается (используйте `export const metadata`). Сборка прошла. | низкий |
| @trpc/server, client, tanstack-react-query | **11.19.0** | Рекомендуемая интеграция — `@trpc/tanstack-react-query`: `createTRPCContext`, `useTRPC`, `queryOptions` и `subscriptionOptions`. В AnyNote старая `@trpc/react-query` (`createTRPCReact`). SSE: `splitLink` → `httpSubscriptionLink`, `tracked(id, data)` + `lastEventId`, `sse.ping`, `reconnectAfterInactivityMs`. Проверка типов с SSE и superjson проходит на TS 7 и TS 6. | низкий |
| @tanstack/react-query | **^5.103** (5.104.0 вышла 26.09) | Свежие версии блокирует `minimumReleaseAge` (§4). | низкий |
| superjson | **2.2.6** | Для денег в decimal нужен `registerCustom` для Decimal (`Prisma.Decimal` — это decimal.js). В AnyNote трансформера нет вовсе. | низкий |
| zod | **4.6.5** | — | низкий |
| better-auth | **1.7.6** | Peer-зависимости: prisma и @prisma/client до ^7 (8 не поддерживается), next до ^16, vitest до ^5. Отличия от 1.6: у аккаунта ключ `(issuer, accountId)` (нужна колонка `Account.issuer`), в правилах капчи — полные пути с `*`, переписан generic OAuth, удалён `oidcProvider`, MCP вынесен в `@better-auth/mcp`, joins перенесены в `advanced.database.joins`. Капча поддерживает только reCAPTCHA, Turnstile, hCaptcha, CaptchaFox и Vercel BotID — **Яндекс SmartCaptcha нет**. Нужен свой хук: POST на `https://smartcaptcha.cloud.yandex.ru/validate` с `secret`, `token`, `ip`. Телеметрия выключена по умолчанию; для 152-ФЗ лучше явно указать `telemetry: { enabled: false }`. | средний |
| @nestjs/core, common, platform-express, microservices, testing | **12.1.0** | Все пакеты теперь ESM; CJS-приложение работает через `require(esm)`. Для запуска нужен Node 20.19+/22.12+/26, для CLI — 22.22.3+/24.15+/26. Внутри Express 5.2.1. Валидация через Standard Schema: zod можно передавать прямо в `@Body()` без class-validator. `@Optional()` больше не наследуется. Хуки жизненного цикла идут по уровням иерархии. Jest загружает ESM-пакеты v12 только на Node ≥24.9. | средний |
| @nestjs/cli | **12.0.7** | Внутри зависимость `typescript ~6.0.2`, но берёт `typescript` из проекта. С TS 7 падает с `getParsedCommandLineOfConfigFile is not a function` (nest-cli #3477, #3479). С псевдонимом на TS 6 `nest build` работает (проверено). | средний |
| @nestjs/config / schedule / swagger | **12.0.1 / 12.0.2 / 12.0.2** | Версии выровнены с Nest (в AnyNote были config ^4 и schedule ^6). У swagger peer `typescript ^5.5 \|\| ^6`. `validationSchema` принимает Standard Schema, Joi — только с 18. | низкий |
| @rekog/mcp-nest | **2.0.7** + @modelcontextprotocol/{core,node,server} **2.1.0** | Архитектура переписана: `McpStrategy` как микросервисный транспорт и `@McpController`. HTTP+SSE удалены, остались Streamable HTTP и STDIO. Обязательный peer — `@nestjs/microservices`. Nest 12 поддерживается с 2.0.3. Сам пакет CJS, на Node 26 импортируется (проверено). Код из AnyNote (1.9) переносить нельзя. | средний |
| prisma, @prisma/client, @prisma/adapter-pg | **7.10.0, строго фиксировать** | Генератор `prisma-client-js` устарел — нужен `prisma-client` с обязательным `output`. Обязательны `PrismaPg` и `prisma.config.ts`; `.env` сам не подгружается. На Node 26 preinstall печатает «only supports 20.19+, 22.12+, 24.0+»: список разрешённых версий в коде, хотя `engines` пишет `>=24`. Предупреждение косметическое, `generate` работает. | средний |
| Метрики | **@prometheus-io/client 0.16.1** вместо prom-client 15.1.3 | `prom-client@15.1.3` помечен в npm как **deprecated**: «replaced by @prometheus-io/client» (увидел при установке). Новый пакет — это prom-client 15 под новым именем. `@willsoto/nestjs-prometheus` 6.1.1 ждёт prom-client, и с новым пакетом получатся два реестра метрик. Проще свой контроллер `/metrics`. | низкий–средний |
| vitest | **5.0.2** + vite **8.3.1** + @vitest/coverage-v8 5.0.2 | Требует Node ≥22.12 и vite как обязательный peer. `clearMocks` теперь true. `vi.mock` — только на верхнем уровне модуля. Непроверенный `await` в асинхронных проверках валит тест. `test.sequential` удалён. Отчёты пишутся в `.vitest`. Inline-проекты по умолчанию наследуют корневой конфиг. | низкий–средний |
| unplugin-swc, @swc/core | **2.0.0, 1.16.2** | Тест DI Nest 12 проходит (проверено). Встроенный в Vite 8 `emitDecoratorMetadata` через oxc тоже прошёл этот тест, но в документации Vite он назван частичным. | низкий |
| jsdom; @testing-library/react; @testing-library/jest-dom; @vitejs/plugin-react | **30.1.1; 16.3.3; 7.0.1; 6.1.1** | plugin-react 6 требует vite ^8. jsdom и jest-dom требуют Node ≥22. | низкий |
| eslint + @eslint/js | **10.11.0 + 10.0.1** | Формат eslintrc удалён. Конфиг ищется от каталога каждого файла. В `recommended` три новых правила. `eslint-plugin-react` 7.37.5 падает с `contextOrFilename.getFilename is not a function` (проверено). | средний |
| typescript-eslint | **8.70.1** | Peer: eslint ^8.57\|\|^9\|\|^10, typescript `>=4.8.4 <6.1.0`. С TS 7 не работает (issue #12518 закрыт как not planned). Типизированный линт на ESLint 10 с псевдонимом TS 6 работает (проверено). | низкий |
| eslint-plugin-react-hooks 7.1.1, @next/eslint-plugin-next 16.3.6, eslint-plugin-turbo 2.11.4, eslint-plugin-only-warn 1.2.1, eslint-config-prettier 10.1.8, globals 17.12.0 | — | На ESLint 10 все работают (проверено). | низкий |
| dependency-cruiser | **18.4.0** | Node ^22\|\|^24\|\|>=26. Поддерживаемый TypeScript: `>=2.0.0 <7.0.0`. С псевдонимом TS 6 работает (проверено). Парсер swc объявлен устаревшим. | низкий |
| prettier / husky / @commitlint/cli + config-conventional | **3.9.9 / 9.1.7 / 21.2.3** | commitlint требует Node ≥22.12. | низкий |
| semantic-release + @semantic-release/changelog, git, github | **25.0.9 + 7.0.0, 11.0.1, 12.0.10** | В AnyNote changelog ^6 и git ^10 — отстали на мажорную версию. | низкий |
| @playwright/test | **1.63.0** | Новый помощник `@next/playwright` `instant()`. | низкий |
| tsx | **4.23.15** | На Node 26 работает без предупреждений (проверено). ts-node 10.9.2 **убрать**: ему нужен API TypeScript. | низкий |
| @sentry/nextjs, @sentry/nestjs (позже) | 11.0.0 | Peer-зависимости Next 16 и Nest 12 допускают. DSN — только на своём сервере (152-ФЗ). | — |

## 2. Что придержать

1. **TypeScript 7 в роли пакета `typescript`.** Ждём 7.1 с API и поддержки в typescript-eslint, dependency-cruiser, @nestjs/cli и @nestjs/swagger.
2. **Prisma 8.** Это RC, выход ожидают в октябре 2026. Требует Node ≥22.18 и TS ≥5.9. В RC нет `$extends`, вложенных записей, уровней изоляции транзакций и кодов ошибок вроде P2002. better-auth её пока не поддерживает. Prisma 7 будет получать исправления 18 месяцев после выхода 8.
3. **`eslint-plugin-react`, `eslint-config-next`, `eslint-plugin-import`, `eslint-plugin-jsx-a11y`.** В peer-зависимостях у них ESLint только до 9. Если без ESLint 10 никак, можно откатиться на ESLint 9.39.5 (тег maintenance).
4. **Pigment CSS и @mui/lab** (бета) — остаёмся на Emotion.
5. **Пре-релизы:** prettier 4 (alpha), semantic-release 26 (beta), vite 8.3 (beta).
6. **prom-client и Jest.** Jest вместе с ts-jest и ts-node не переносим, берём Vitest. prom-client заменяем.
7. **Свежие версии младше 24 часов.** pnpm их не ставит (§4). Сейчас это @tanstack/react-query 5.104.0 и 5.103.3.

## 3. Схема TypeScript: 7 для проверки, 6 для инструментов

Это вариант, который рекомендует Microsoft. Каталоги pnpm с `npm:`-псевдонимами работают (проверено).

```yaml
# pnpm-workspace.yaml → catalog
typescript: npm:@typescript/typescript6@6.0.2   # API для eslint, depcruise, nest-cli, next build, swagger; bin tsc6
'@typescript/native': npm:typescript@7.0.2      # bin tsc = 7.0.2
```

- Задача `typecheck` в turbo: `next typegen && tsc --noEmit` (здесь `tsc` — это TS 7). В тесте на Next-приложении TS 7 отработал за 0,24 с, TS 6 — за 0,93 с.
- В `next.config.ts` можно поставить `typescript.ignoreBuildErrors: true`, чтобы типы не проверялись дважды (иначе Next проверит их через tsc6). Шлюзом тогда остаётся `pnpm typecheck` в CI.
- В базовом tsconfig обязательно указать `rootDir` и `types` (например `["node"]`) и не использовать `baseUrl`.
- **Непроверено:** в пакете-совместимости нет `lib/tsserver.js`, есть только `tsserverlibrary.js`. Возможно, VS Code с «Use Workspace Version» его не увидит, и тогда плагин `next` в редакторе не заработает.
- Альтернатива: `typescript: 6.0.3` плюс тот же псевдоним на 7.0.2. Тогда `tsc` = 7.0.2, а `tsserver` = 6 (проверено). Но какой пакет займёт bin `tsc`, решает pnpm неявно, так что этот вариант хрупкий.

## 4. pnpm 12: установка и обязательные изменения

**Установка на macOS с nvm.** Corepack в Node 26 нет. Два способа:
- `npm i -g pnpm@12.6.0` — пакет подтягивает `@pnpm/exe.darwin-arm64`. Глобальные пакеты nvm привязаны к версии Node, поэтому после `nvm install` ставить заново.
- `curl -fsSL https://get.pnpm.io/install.sh | sh -` — не зависит от Node.

Сейчас глобально стоит pnpm 9.15.9.

**Корневой `package.json`:**
```json
"engines": { "node": ">=26.10.0 <27" },
"devEngines": {
  "runtime": { "name": "node", "version": ">=26.10.0 <27", "onFail": "error" },
  "packageManager": { "name": "pnpm", "version": "^12.6.0", "onFail": "download" }
}
```
- Поле `packageManager` не нужно: turbo 2.11 объявил его устаревшим.
- Утверждение «pnpm 12 падает, если заданы оба поля» на 12.6.0 при одинаковых версиях **не подтвердилось**.
- С `devEngines.packageManager` команды `npm` и `npx` внутри репозитория падают с `EBADDEVENGINES` (проверено). Вместо них — `pnpm dlx` или `pnx`.

**`pnpm-workspace.yaml`** — здесь вся конфигурация pnpm. В `.npmrc` остаются только registry и авторизация. Поле `pnpm` в `package.json` не читается с версии 11.
```yaml
packages: [apps/*, packages/*]
catalog: { ... }
allowBuilds:            # onlyBuiltDependencies удалён в pnpm 11
  prisma: true
  '@prisma/engines': true
  '@swc/core': true
  esbuild: true
```

Что изменилось по умолчанию и что я проверил на практике:
- **`strictDepBuilds: true`.** Установка падала с `ERR_PNPM_IGNORED_BUILDS` на prisma и @prisma/engines. После сбоя pnpm сам дописал в yaml заглушки `set this to true or false` — их надо убрать руками.
- **`minimumReleaseAge: 1440`.** pnpm сам добавил в `minimumReleaseAgeExclude` пакеты @tanstack/react-query 5.104.0 и @types/node 26.6.3, потому что им меньше суток.
- **`blockExoticSubdeps: true`.**
- **Опечатка в ключе** (`nodeLinkerr`) → ошибка `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`.
- **Lockfile теперь из двух YAML-документов.** Первый — `packageManagerDependencies` с самим pnpm, второй — проект. У обоих `lockfileVersion: '9.0'`. Внешние парсеры (Dependabot, SCA) это пока ломает.
- Прочее: store `~/Library/pnpm/store/v11`; переменные окружения `pnpm_config_*`; `pmOnFail` вместо `managePackageManagerVersions`; git-зависимости только по HTTPS; `--frozen-lockfile false` заменён на `--no-frozen-lockfile`; `--resolution-only` заменён на `pnpm peers check`.

## 5. Что проверено руками

Тестовый монорепозиторий в `.../scratchpad/exp`, Node 26.5.0, pnpm 12.6.0. Всё перечисленное работает:
- turbo: `typecheck`, `--dry=json`, `prune`;
- `next build` 16.3.6 с MUI 9.4, `v16-appRouter`, MDX с `remark-gfm` через Turbopack и `next.config.ts`;
- `next typegen` плюс `tsc` 7 и 6;
- ESLint 10: typescript-eslint с типизированным линтом, next, react-hooks (срабатывают новые правила вроде `set-state-in-effect`), turbo, only-warn, prettier;
- падение `eslint-plugin-react` на ESLint 10 воспроизвелось;
- depcruise с TS 6;
- Nest 12.1 как ESM с top-level await: `nest build` и `node dist/main.js`;
- Vitest 5 с DI — и с unplugin-swc, и без него;
- импорт mcp-nest 2.0.7;
- `prisma generate` 7.10 (`prisma-client`, `moduleFormat=esm`, Decimal), проверка типов на TS 7 и 6;
- tRPC 11.19 tanstack с `useSubscription`, `tracked` и superjson с Decimal — проверка типов на TS 7 и 6;
- tsx на Node 26.

Файлы проекта я не трогал. Побочные эффекты — заполненные кеши `~/.npm` и `~/Library/pnpm/store/v11`.

## 6. Ошибки AnyNote, которые не надо переносить

- В `pnpm-workspace.yaml` есть `allowBuilds`, но стоит `packageManager: pnpm@9.0.0`. pnpm 9 этот ключ не знает, поэтому настройка ничего не делает. Кроме того, фактически установлен pnpm 9.15.9, а не 9.0.0.
- Используется `v15-appRouter` при Next 16.
- Генератор `prisma-client-js` с `engineType`.
- В eslint-config `next.ts` повторно подключаются `js.recommended`, prettier и tseslint, хотя они уже есть в base.
- `react-google-recaptcha-v3` — заменить на SmartCaptcha.
- Jest с ts-jest и ts-node в engines.
- Устаревшие мажорные версии плагинов semantic-release.
- `next build --webpack`: в Радити нет likec4 и drawio, поэтому достаточно Turbopack по умолчанию.

## 7. Что остаётся неясным

- Срок выхода TS 7.1 с API неизвестен; «около октября» — только по сторонним блогам.
- Issue Next #95490 (TS 7 определяется как отсутствующий) в моём снимке страницы был открыт. На схеме с псевдонимом я его не воспроизвёл, «чистый» TS 7 в Next не проверял.
- Официальной поддержки Node 26 у Prisma 7.10 нет (только предупреждение в preinstall).
- Сборщик `nest build -b swc` на Nest 12 не проверял, проверял только tsc.
- Вспомогательные действия для CI с pnpm 12 (`pnpm/setup` против `pnpm/action-setup`) не проверял — это понадобится вместе с деплоем.
- Дата выхода pnpm 12.0.0: по npm — 26.08.2026, InfoQ пишет 03.09.

## Источники

- TS 7.0: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Next 16.3: https://nextjs.org/blog/next-16-3 · https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli · https://nextjs.org/docs/app/api-reference/config/typescript · https://nextjs.org/docs/app/guides/mdx · https://github.com/vercel/next.js/issues/95490 · https://github.com/vercel/next.js/issues/91702
- typescript-eslint: https://typescript-eslint.io/users/dependency-versions/ · https://github.com/typescript-eslint/typescript-eslint/issues/12518
- eslint-plugin-react и ESLint 10: https://github.com/jsx-eslint/eslint-plugin-react/issues/4018 · https://eslint.org/docs/latest/use/migrate-to-10.0.0
- pnpm: https://pnpm.io/blog/releases/12.0 · https://pnpm.io/blog/releases/11.0 · https://github.com/pnpm/pnpm/releases/tag/v12.0.0 · https://github.com/pnpm/pnpm/releases/tag/v10.0.0 · https://pnpm.io/settings/build · https://pnpm.io/settings/cli · https://pnpm.io/installation · https://pnpm.io/package_json · https://github.com/fluidd-core/fluidd/pull/1961 · https://www.infoq.com/news/2026/09/pnpm-12-rust/
- Turborepo: https://turborepo.dev/blog/2-11 · https://github.com/vercel/turborepo/issues/12648
- Node: https://nodejs.org/en/blog/release/v26.0.0 · https://github.com/nodejs/Release (schedule.json) · https://nodejs.org/api/corepack.html
- NestJS: https://docs.nestjs.com/migration-guide · https://trilon.io/blog/nestjs-12-is-now-available · https://docs.nestjs.com/recipes/swc · https://github.com/nestjs/nest-cli/issues/3477 · https://github.com/nestjs/nest-cli/issues/3479
- mcp-nest: https://github.com/rekog-labs/MCP-Nest/releases
- Vitest и Vite: https://vitest.dev/blog/vitest-5.html · https://vitest.dev/guide/migration · https://vite.dev/blog/announcing-vite8 · https://vite.dev/guide/features · https://github.com/unplugin/unplugin-swc/releases
- Prisma: https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7 · https://www.prisma.io/docs/orm/release-status · https://github.com/prisma/orm/issues/30322 · https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types
- MUI: https://mui.com/material-ui/integrations/nextjs/
- better-auth: https://better-auth.com/blog/1-7 · https://github.com/better-auth/better-auth/releases/tag/v1.7.0 · https://www.better-auth.com/docs/plugins/captcha · https://www.better-auth.com/docs/reference/telemetry
- Yandex SmartCaptcha: https://yandex.cloud/en/docs/smartcaptcha/quickstart
- tRPC: https://trpc.io/docs/client/tanstack-react-query/setup · https://trpc.io/docs/client/links/httpSubscriptionLink · https://trpc.io/docs/server/subscriptions
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser/releases/tag/v18.0.0
- prom-client: https://github.com/honojs/middleware/issues/2126

Версии, peer-зависимости и `engines` взяты из `npm view` на 26.09.2026.