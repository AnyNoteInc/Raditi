# Этап Э6а: обновление копии

Дата: 01.11.2026. Договор срезов ядра `code_sync`, листинга до скачивания, корней медиа, дрейфа и одной копии базы на сайт. Основа: `62-site-stacks.md` (Т17, Т47–Т51, §2.6, §5.1, §5.3, §6), `62-onboarding.md` (правка 17, доски `O-setup-running` и `O-sync-*`), `docs/research/2026-11-site-stacks/attack-decisions.md` (А2, А10, А11, А27, C21, C25), `docs/research/2026-11-site-stacks/map/gap-one-shot-full-import.md`. Договор сверен с итоговым проектом и потоком мастера 01.11.2026.

**Как читать.** Пути — от корня дерева. Номера строк сверены по `raditi-stacks` (`feat/site-stacks`, `c811abf1`, равно `main`) и сдвинутся после Э0 и Э2: ищите по символам. Пересечение с веткой чатов сверено по `raditi-chats` `f4501ebb`: из файлов этапа ветка меняет `packages/db/src/site-leases.ts`, `site-leases.test.ts`, `index.ts`, `enums.test.ts`, `release-undo.test.ts`, `packages/db/prisma/schema.prisma`, `packages/domain/src/ports/turn-runner.ts`, `apps/core/src/previews/preview-builder.ts`, `preview-facts.ts`, `preview-facts.test.ts`, `preview-manager.integration.test.ts`, `packages/trpc/src/services/chat/undo.ts`, `packages/trpc/src/routers/site-access-change.test.ts` (уборка фикстуры, другое место), `infra/dev/release-verify/scenarios.mjs`, `README.md`, `docs/spec.md`; конфликт малый, строки названы в срезах. Файлы импорта, `git-workspace`, `site-setup.tsx` и `setup-text.ts` ветка не меняет.

**Что считается известным из ранних этапов** (`62-slices/e0.md`, `62-slices/e2.md`). Э0ж: `ImportRules.documentFolders`, `createImportPathPolicy(exclude, documentFolders)`, `importPolicyOf`. Э2.1: `sites.stack_facts`, `siteStackFactsPatchSchema`, `mergeSiteStackFacts`. Э2.3: `SiteTree`, `SiteRead`, `driftProbe`, `SiteDriftProbe`. Э2.6: `GitWorkspaceService.readFile` и `listDirectory`. Э2.8: `readStack`, `StackReading`, `siteTreeOf`, `recordStackFacts`, код `layout_unsupported`. Э2.9: `withRoot(siteId, signal, (tree) => …)`, `readSiteRoot`, `RootReading`, правило «один `withRoot` на сборку». Если в дереве другое имя, срез останавливается и правит этот договор.

**Общее для всех срезов.**
- Срез — один коммит, Conventional Commits, только свои пути. После него `pnpm gates` зелёный, WordPress работает как раньше, кроме изменений, названных в «Договоре».
- Правило 8: сравнений имени стека нет. Всё, что зависит от стека, читается из `SiteAdapter`.
- Логи несут id и коды. Ни пути, ни хоста, ни сообщения сервера в логах и в `error_code` нет: это порядок импорта (`site-import.runner.ts:98`).
- До Э6б клиент кнопки не видит: вход — команда оператора `sites:sync` и стенды. Кнопка отмены в `dialog-facts.ts` не меняется (Э6б.1): после `code_sync` она стоит, а `undo-planner` отказывает `undo_outdated` (`undo-planner.ts:127-138`).
- Т47 работы не требует: коннектор не строится.

| Срез | Название | Решения | Зависит |
| --- | --- | --- | --- |
| Э6а.1 | Листинг до скачивания | Т48, текст Т51 | Э2.8 |
| Э6а.2 | Корни медиа и порог | Т49 | Э6а.1 |
| Э6а.3 | Обход выносится в `readCodeTree` | А27 | Э6а.1 |
| Э6а.4 | Git: дерево `main`, коммит с хостинга, уборка зеркала | А27 | Э2.6 |
| Э6а.5 | Таблица и барьер | Т50, А2, §2.6 | Э2.1 |
| Э6а.6 | Что меняется, потому что `main` сдвинулся | Т50, А10 | Э6а.5 |
| Э6а.7 | Сравнение и сводка | Т50 с правкой 17, А11, C21 | Э6а.2, Э6а.3, Э6а.4, Э6а.5 |
| Э6а.8 | Принятие и сборщик | Т50 с правкой 17 | Э6а.6, Э6а.7 |
| Э6а.9 | Команда `sites:sync`, стенды М4б, правило 3 | Т50, М4б | Э6а.8 |
| Э6а.10 | Дрейф | Т17 | Э2.6, Э2.9, Э6а.6 |
| Э6а.11 | Одна копия базы на сайт | Т51 | Ничего |
| Э6а.12 | `code_sync` на новых стеках: сценарий R8 | Т66, М4б, З7 | Э6а.9, Э3.12 |

Параллельно можно вести две ветки работ: `.1 → .2 → .3` (импорт) и `.4` с `.5 → .6` (git и база); `.10` и `.11` идут в любой момент после своих зависимостей. Весь этап не трогает файлов Э3–Э5, кроме строки `mediaRoots` в их адаптерах (Э6а.2).

## Э6а.1. Листинг до скачивания

**Э6а.1. Обход сначала только читает папки, потом скачивает.**
- *Цель.* Сайт, который не войдёт, получает `source_too_large` до первого скачанного файла, а не через 12–45 минут. Закрывает Т48 и строку «Отказ по размеру через 12–45 минут» §5.2. Пределы (`siteImportLimits.treeBytes` 1 ГиБ, `files` 100 000, `ftpSessions` 2) не меняются.
- *Файлы.*
  - `apps/core/src/site-provisioning/tree-walk.ts` — `walkSiteTree` (строки 123–270) делится на два шага.
  - `apps/core/src/site-provisioning/tree-walk.test.ts`.
  - `apps/core/src/site-provisioning/site-import.ts` — `fetchTree` (строки 547–557) зовёт оба шага по отдельности.
  - `apps/core/src/site-provisioning/stage-store.ts:264` — `claim` ставит `step = 'list'`.
  - `apps/core/src/site-provisioning/stage-store.integration.test.ts:120` — ожидание `step: 'list'`.
  - `apps/core/src/testing/site-import-store.ts:147` — то же в подделке.
  - `packages/domain/src/site-connection/kinds.ts:30`, `provisioning.test.ts:304`.
  - `packages/domain/src/site-connection/reasons.ts:63` — устаревший комментарий: `// Over 100 000 files, 1 GiB, the listing ceilings or a 1 GiB bundle.`
  - `apps/web/src/components/site/setup-text.ts`, `setup-text.test.ts`.
  - `apps/web/src/components/site/site-setup.tsx`, `site-setup.test.tsx` — четвёртый этап и строка о нагрузке (доска `O-setup-running`).
  - `infra/dev/site-import-verify/scenarios.mjs:504` — R1 ждёт `stage.step === 'list'`: хостинг заморожен, до `fetch` дело теперь не дойдёт.
  - `docs/spec.md` §12, «Импорт»: одна строка о двух шагах и о шаге `list`.
- *Договор.*

  ```ts
  // packages/domain/src/site-connection/kinds.ts
  export const provisioningSteps = ['list', 'fetch', 'publish'] as const

  // apps/core/src/site-provisioning/tree-walk.ts
  /** A file the listing found, not read yet. */
  export interface ListedFile {
    /** As the server understands the segments: the folder's, then the file's own. */
    refs: string[]
    path: string
    /** As listed: the most `read` may send. */
    size: number
  }
  export interface TreeListing {
    files: ListedFile[]
    /** Listed sizes of `files`: within `treeBytes` before a byte is read. */
    bytes: number
    skipped: SkipCounts
  }
  export type ListInput = Pick<WalkInput, 'session' | 'policy' | 'markers' | 'closedRoots' | 'signal' | 'onWork' | 'limits'>
  export type DownloadInput = Pick<WalkInput, 'session' | 'blobs' | 'values' | 'signal' | 'onWork' | 'limits'>
  export function listSiteTree(input: ListInput): Promise<TreeListing>
  export function downloadListed(input: DownloadInput, listing: TreeListing): Promise<WalkResult>
  /** `listSiteTree`, then `downloadListed`: what the tests of the walk call. */
  export function walkSiteTree(input: WalkInput): Promise<WalkResult>
  ```

  `listSiteTree` держит всё, что сейчас стоит в цикле строк 184–266, кроме скачивания: проверки `isImportSegment`, `seen`, `policy.decide`, ссылки, `nested_site`, `closed_stack` (Э2.8), `outside_root`, папку `unreadable`, `too_large`, глубину. `directories`, `listedEntries`, `files` и `treeBytes` бросают `refuse('source_too_large')` здесь, поэтому отказ приходит раньше первого `session.read` дерева. `readStack` (Э2.8) и `configSecrets` читают свои файлы до листинга, как сейчас (строка 538).

  `downloadListed` идёт по `listing.files` пулом `inPool(listing.files, concurrency, download)`: `session.concurrency` сразу на всё дерево, а не на папку. Счётчики `skipped` начинаются со значений листинга.

  Файл, выросший после листинга (`gap-one-shot` §4, п. 1). `download` ловит `FileSourceGuardError('bytes')`, копию удаляет и кладёт файл в список `grown`, отказа нет. Других ошибок это не меняет. После пула, по одному, потому что `list` не идёт рядом с `read` (`tree-walk.test.ts:252`):
  1. `session.list(<папка файла>, limits.listedEntries)`; `isUnreadable` — `skip('unreadable')`, другая ошибка — `sessionFailure`.
  2. Записи с тем же `ref` и `type === 'file'` нет — `skip('unreadable')`.
  3. Новый размер больше `fileBytes` — `skip('too_large')`.
  4. `bytes + новый размер > treeBytes` — `refuse('source_too_large')`.
  5. `read` с новым размером как пределом. Снова `FileSourceGuardError('bytes')` — `refuse('source_inconsistent')`.

  `fetchTree`:

  ```ts
  const listing = await listSiteTree({ session, policy, markers: rules.rootMarkers(),
    closedRoots: deps.closedRoots, signal: walkSignal, onWork })
  await deps.store.setStep(lease, 'fetch')
  walk = await downloadListed({ session, blobs, values, signal: walkSignal, onWork }, listing)
  ```

  Тексты `setupStageText`, дословно (Т48, Т51, доска `O-setup-running`). Итог получает поле `load`: на доске строка о нагрузке стоит своим абзацем обычного размера и только на этапе копирования, поэтому в заметку она не дописывается:

  ```ts
  const copyLoad = 'Пока мы копируем файлы, сайт может открываться медленнее.'
  // step === 'list'
  { title: 'Считаем файлы сайта.', note: 'Смотрим, войдёт ли сайт в копию целиком.', load: null }
  // running без шага publish: заголовок и заметка прежние, load: copyLoad
  // publish и ожидание: как сейчас, load: null
  ```

  `site-setup.tsx`: под `stage.note` (строка 290) строка `load`, если она есть. `SetupSteps` (строки 47–55) показывает четыре этапа: вторым `Считаем файлы сайта`. При `step === 'list'` он текущий, «Копируем файлы сайта» ещё `later`; при скачивании и публикации он `done`. Срока не обещаем: «до часа» остаётся только у скачивания.

  Запрещено: поднимать пределы, менять `ftpSessions`, читать файл до конца листинга.
- *Тесты.* В `tree-walk.test.ts`:
  - новый `refuses a tree over the limit before the first file is read`: две папки, вторая выводит сумму за `treeBytes`, ожидание `session.reads` пуст. Падает до правки: файлы первой папки уже скачаны.
  - `fails source_inconsistent when a file grows beyond its listed size` (строка 169) заменяется на `reads a file that grew once by its new size, and fails when it grows again`. Подделке `fakeSession` нужен `listedSize`, зависящий от номера листинга.
  - новые `counts as unreadable a file that grew and is gone`, `leaves out a file that grew over fileBytes`.
  - `setup-text.test.ts`: на `step: 'list'` заголовок и заметка дословно и `load: null`; на `step: 'fetch'` `load` равен строке Т51, на `publish` — `null`.
  - `site-setup.test.tsx`, новый: при `step: 'list'` в списке этапов `Считаем файлы сайта` с `aria-current`, а «Копируем файлы сайта» без него, строки Т51 нет; при `step: 'fetch'` этап подсчёта пройден, строка Т51 на экране. Существующие тесты на `fetch` и `publish` не меняются.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:site-import`.
- *Готово.* Импорт идёт шагами `list`, `fetch`, `publish`, экран показывает четыре этапа. `verify:site-import` прежние 47 проверок проходит, R1 ждёт `list`.
- *Зависит.* Э2.8: он правит те же строки `fetchTree`.
- *Параллельно.* С Э6а.4, Э6а.5, Э6а.11 и этапами Э3–Э5.

## Э6а.2. Корни медиа и порог

**Э6а.2. Адаптер называет медиа, импорт считает их до скачивания.**
- *Цель.* Появляется `ImportRules.mediaRoots`: корни, расширения и исключения (Т49). Новые стеки сверх порога получают честный отказ сразу после листинга. Те же корни нужны `code_sync` (Э6а.7), поэтому их объявляет и WordPress.
- *Файлы.*
  - `packages/domain/src/ports/site-adapter.ts:51-56` — тип `MediaRoots`, поле.
  - `packages/domain/src/site-connection/import-policy.ts`, `import-policy.test.ts` — `createMediaMatcher`.
  - `packages/domain/src/site-connection/limits.ts` — `mediaBytes`, `mediaFiles`.
  - `packages/domain/src/site-connection/reasons.ts` — код `media_too_large`.
  - `packages/site-adapters/src/php-hosting.ts` — `mediaFileExtensions`.
  - `packages/site-adapters/src/wordpress.ts:275-283`, `packages/site-adapters/src/bitrix.ts:75-83`.
  - `packages/site-adapters/src/import-rules.test.ts`.
  - Адаптеры Joomla, OpenCart и MODX, если они уже влиты; иначе значения таблицы ниже входят в договор их срезов.
  - `apps/core/src/site-provisioning/tree-walk.ts`, `tree-walk.test.ts`, `site-import.ts`.
  - `apps/web/src/components/site/setup-text.ts`, `setup-text.test.ts`.
- *Договор.*

  ```ts
  // packages/domain/src/ports/site-adapter.ts
  export interface MediaRoots {
    /** Folders from the site root, each with a trailing `/`. */
    roots: readonly string[]
    /** Lower case, without a dot. A file of any other extension below a root is code. */
    extensions: readonly string[]
    /**
     * For a root no list of extensions covers: plugins write fonts, styles and sound there. Every
     * file below it is media but a name with one of these parts. One of the two lists is empty.
     */
    code: readonly string[]
    /** Folders below a root that hold code: `assets/components/`. */
    except: readonly string[]
    /** The threshold of Т49 applies: it stops the import, and from Э12 leaves the media on the hosting. False keeps them in git. */
    capped: boolean
  }
  export interface ImportRules {
    gitignore: string[]
    exclude: string[]
    documentFolders: string[]              // Э0ж
    mediaRoots: MediaRoots | null          // обязательное поле, §2.3
  }

  // packages/domain/src/site-connection/import-policy.ts
  /** Throws badRequest for a root or an exception that is not `a/b/`, as createImportPathPolicy does. */
  export function createMediaMatcher(media: MediaRoots | null): (path: string) => boolean

  // packages/domain/src/site-connection/limits.ts, siteImportLimits
  mediaBytes: 256 * 1024 * 1024,
  mediaFiles: 10_000,

  // packages/domain/src/site-connection/reasons.ts, provisioningErrorCodes
  // More media than mediaBytes or mediaFiles, in a stack whose adapter caps it.
  'media_too_large',

  // apps/core/src/site-provisioning/tree-walk.ts
  // ListInput получает isMedia: (path: string) => boolean; TreeListing получает
  media: { files: number; bytes: number }
  ```

  `null` у `createMediaMatcher` — всегда `false`. Корень сравнивается с началом пути точно, расширение и части имени — без учёта регистра. Путь под `except` — не медиа. Оба списка `extensions` и `code` пусты или оба непусты — `badRequest`.

  | Стек | `roots` | `except` | `extensions` | `code` | `capped` |
  | --- | --- | --- | --- | --- | --- |
  | WordPress | `wp-content/uploads/` | нет | нет | `phpCodeNameParts` | `false` |
  | Битрикс | `mediaRoots: null` | | | | |
  | Joomla | `images/`, `files/` | нет | `mediaFileExtensions` | нет | `true` |
  | OpenCart | `image/` | `image/cache/` | `mediaFileExtensions` | нет | `true` |
  | MODX | `assets/` | `assets/components/`, `assets/templates/` | `mediaFileExtensions` | нет | `true` |

  `capped: false` у WordPress — расхождение Р4. Joomla — те же папки, что `documentFolders` Э3. OpenCart — Р14. MODX — Т49 и Э5.

  У WordPress кодом под `uploads` считается только то, что исполняется. Шестнадцати расширений тут мало: плагины пишут туда `css`, `js`, `json`, шрифты, звук и видео, а Elementor пересобирает CSS при каждой правке страницы (`wordpress-db-copy.ts:231`). Если считать это кодом, клиент после правки страницы читает «изменилось 214 файлов кода… проверьте сайт», а `main` сдвигается без правки кода (C21).

  ```ts
  // packages/site-adapters/src/php-hosting.ts
  export const mediaFileExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
    'mp4', 'webm', 'pdf', 'doc', 'docx', 'odt', 'rtf'] as const
  /** What Apache and PHP run or read as configuration: the part of `refusedNameParts` without `.svg`. */
  export const phpCodeNameParts = ['.php', '.pht', '.phar', '.htaccess', '.user.ini'] as const
  ```

  `.php` под `wp-content/uploads/` остаётся кодом: `code_sync` его читает, показывает и сканирует.

  Порог стоит в `fetchTree` сразу после `listSiteTree`, до `setStep('fetch')`, чистой функцией:

  ```ts
  export const mediaOverThreshold = (media: TreeListing['media'], roots: MediaRoots | null): boolean =>
    roots?.capped === true &&
    (media.files > siteImportLimits.mediaFiles || media.bytes > siteImportLimits.mediaBytes)
  ```

  Текст `importTexts.media_too_large` (рекомендация, вопрос В1): «На сайте слишком много картинок и документов: мы копируем до 10 000 таких файлов и до 256 МБ. Такие сайты мы пока не подключаем.» Это значение вопроса Он27: доска `O-layout-unsupported` идёт другими словами, ответ меняет только эту строку.

  Проект при этом уже записан (Т16). Вид «Слишком много файлов» на экране настройки, хвост о панели, кнопки и открытые разделы — дело Э9.2: `media_too_large` идёт там вместе с `source_too_large`.

  Запрещено: `exclude`-строки вместо `mediaRoots` (`createImportPathPolicy` не выражает `**`), предел на стек сверх этого порога, чтение имени стека в ядре.
- *Тесты.*
  - `import-policy.test.ts`: матчер, регистр расширения, `except`, отказ на `a/*/`, на корне без `/`, на двух пустых и двух непустых списках.
  - `import-rules.test.ts`: у каждого адаптера `mediaRoots` проходит `createMediaMatcher`; у WordPress `wp-content/uploads/a.jpg`, `elementor/css/post-1.css`, `x.woff2`, `x.mp3`, `x.mov`, `x.json` под `uploads` — медиа, `wp-content/uploads/a.php`, `a.phtml`, `.htaccess` — нет.
  - `tree-walk.test.ts`: `counts the media of the listing apart`.
  - `site-import.test.ts`: новый `refuses media_too_large right after the listing` на адаптере с `capped: true` и подставленными пределами: `session.reads` пуст, код этапа `media_too_large`. Падает до правки: кода нет, файлы скачаны. Рядом контроль: тот же сайт при `capped: false` импортируется.
  - `setup-text.test.ts`: `Record` требует текст, тест сверяет строку. `provisioning.test.ts`: число кодов на один больше.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:site-import`.
- *Готово.* `ImportRules.mediaRoots` объявлен у всех адаптеров, WordPress импортируется как раньше при любом объёме медиа в пределах 1 ГиБ.
- *Зависит.* Э6а.1.
- *Параллельно.* С Э6а.4, Э6а.5, Э6а.11. С Э3–Э5 только через правило «значения таблицы».

## Э6а.3. Обход выносится из `ImportRun`

**Э6а.3. `readCodeTree` не знает этапа и его аренды.**
- *Цель.* Обход и сканы становятся общей функцией: `readAccess` отказывает сайту не в `onboarding` (`site-import.ts:233`), а `ImportRun` держит этап, поэтому `code_sync` не может взять их как есть (А27). Поведение импорта не меняется.
- *Файлы.*
  - Новый `apps/core/src/site-provisioning/code-tree.ts`.
  - `apps/core/src/site-provisioning/site-import.ts` — уходят `fetchTree` (477–592), `assertScanner` (204–212), `pinAddress` (337–349), `readReferenced` (301–334), `databaseValues` (262–294), `addCounts` (134–136), интерфейс `CheckedAccess` (96–101).
  - `apps/core/src/site-provisioning/stage-store.ts` — тело `readAccess` делится.
  - Новый `apps/core/src/site-provisioning/code-tree.test.ts`.
- *Договор.*

  ```ts
  // apps/core/src/site-provisioning/code-tree.ts
  export interface CheckedAccess {
    adapter: FileSourceAdapter
    access: unknown
    databaseValues: string[]
  }
  export type CodeTreeDeps = Pick<
    SiteImportDeps,
    'appEnv' | 'secrets' | 'sources' | 'databases' | 'stacks' | 'closedRoots' | 'lookup' | 'gitleaksBinary' | 'fetchOriginal' | 'stall'
  >
  export interface CodeTreeSite { id: string; stack: SiteStack; url: string }
  export interface CodeTreeRun {
    site: CodeTreeSite
    /** A private directory of the run: `<root>/blobs` and the reports of the scan. */
    root: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    /** What readStack found, before the listing: `recordStackFacts` and `layout_unsupported` of an import. */
    onStack(reading: StackReading): Promise<void>
    /** Runs right after the listing, before the first file: the threshold and `setStep` of an import. */
    onListed(listing: TreeListing): Promise<void>
  }
  export interface CodeTree { taken: TakenFile[]; skipped: SkipCounts }

  export function assertScanner(binary: string, root: string, env: NodeJS.ProcessEnv): Promise<void>
  /** Everything `readAccess` checks after the status of the site. */
  export function checkedAccess(site: CodeTreeSite, stored: StoredAccess, deps: CodeTreeDeps): Promise<CheckedAccess>
  export function readCodeTree(run: CodeTreeRun, checked: CheckedAccess, deps: CodeTreeDeps): Promise<CodeTree>
  ```

  В `importSite` остаётся только то, что знает этап:

  ```ts
  async function readAccess(stage, lease, deps) {
    const stored = await deps.store.readAccess(lease)
    if (stored.siteStatus !== 'onboarding') throw refuse('access_refused')
    return checkedAccess({ id: stage.siteId, stack: stage.stack, url: stage.url }, stored, deps)
  }
  ```

  `onStack` импорта — три строки Э2.8: `recordStackFacts`, `if (reading.refused) throw refuse('layout_unsupported')`. `onListed` импорта: `mediaOverThreshold` и `setStep(lease, 'fetch')`. Сам `readStack` и `siteTreeOf` зовёт `readCodeTree`, на том же месте внутри `try`.

  `stage-store.ts`: код внутри `#fenced` в `readAccess` (строки 303–353) становится приватной `#accessOf(tx, siteId)`. Появляется `readAccessOf(siteId): Promise<StoredAccess>` без ограждения этапа, через `#transaction`.

  Запрещено: менять порядок проверок, тексты, коды и счётчики; `code-tree.ts` не импортирует `stage-store`, кроме типа `StoredAccess`.
- *Тесты.*
  - Все существующие `site-import.test.ts`, `site-import.runner.test.ts`, `stage-store.integration.test.ts` проходят без правок: это и есть доказательство. Меняются только импорты.
  - Новый `code-tree.test.ts`: `reads the tree of a site that is no longer being connected` — `stored.siteStatus === 'active'`, функция работает без этапа и без `store`. Не компилируется до правки.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:site-import`.
- *Готово.* `site-import.ts` короче на 300 строк, дифф поведения пуст.
- *Зависит.* Э6а.1. С Э6а.2 — один файл, порядок: сначала Э6а.2.
- *Параллельно.* С Э6а.4, Э6а.5.

## Э6а.4. Git: дерево `main`, коммит с хостинга, уборка зеркала

**Э6а.4. Новые методы `GitWorkspaceService`.**
- *Цель.* Коммит с родителем `main` из файлов хостинга собирается в зеркале `core` и не отправляется. `buildCommit` делает только корневой коммит, а `trustedCommit` не принимает дерево с хостинга (Т50, А27).
- *Файлы.*
  - `apps/core/src/git-workspace/git-workspace.service.ts` — методы ниже; поправка ложного комментария у `trustedCommit` (строка 794, см. Р6).
  - Новый `apps/core/src/git-workspace/code-sync-git.ts`.
  - Новый `apps/core/src/git-workspace/git-workspace.hosting-commit.test.ts`.
- *Договор.*

  ```ts
  // apps/core/src/git-workspace/git-workspace.service.ts
  export interface TreeFile {
    path: string
    mode: '100644' | '100755' | '120000' | '160000'
    oid: string
    /** 0 for a submodule. */
    bytes: number
  }
  /** Every entry of a commit's tree with its size, within FULL_TREE_FILES and FULL_TREE_LIST_BYTES. */
  async treeFiles(input: { repo: RepoRef; sha: string }): Promise<TreeFile[]>

  export interface HostingCommitInput {
    repo: RepoRef
    /** `main` as the comparison found it: the only parent. */
    parent: string
    /** Absolute `blob`: a copy the caller keeps; its bytes become the entry at `path`. */
    write: readonly { path: string; blob: string; bytes: number; mode: '100644' | '100755' }[]
    /** Paths of `parent` the commit removes. */
    remove: readonly string[]
    message: string
    committedAt: string
  }
  export interface HostingCommit {
    sha: string
    /** Paths of `write` git left out (core.protectNTFS, core.protectHFS). */
    dropped: string[]
  }
  /** null — the tree is the tree of `parent`: nothing to commit. Pushes nothing. */
  async hostingCommit(input: HostingCommitInput): Promise<HostingCommit | null>

  /** Drops what the mirror of the repository holds and no ref reaches; no mirror — nothing to do. */
  async dropUnreachable(input: { repo: RepoRef }): Promise<void>

  // apps/core/src/git-workspace/code-sync-git.ts
  export type CodeSyncGit = Pick<
    GitWorkspaceService,
    'readBranchHead' | 'treeFiles' | 'hostingCommit' | 'pushTrustedCommit' | 'dropUnreachable'
  >
  export interface CodeSyncCommitFacts { syncId: string; siteId: string }
  export const codeSyncMessage = (facts: CodeSyncCommitFacts): string =>
    `Raditi code sync\n\nRaditi-Sync: ${facts.syncId}\nRaditi-Site: ${facts.siteId}\n`
  ```

  `treeFiles`: `ls-tree -rlz --full-tree <sha>`, разбор регулярным выражением `^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([^\0]+)$`, путь — `isPublicationPath`, иначе `failed()`. Предел через `this.list(…, FULL_TREE_FILES, REPOSITORY, FULL_TREE_LIST_BYTES)`.

  `hostingCommit`, по шагам, под схемой zod в стиле `trustedCommitSchema` (`publicationShaSchema`, `isPublicationPath`, без повторов путей, `isAbsolute(blob)`, `write ∩ remove` пусто):
  1. `workspace(repo, [parent])`.
  2. `objects = join(mirrorPath(this.#mirrorDir, repo, workspace.url), 'objects')`. Все следующие команды идут с `env: { GIT_OBJECT_DIRECTORY: objects }`, поэтому объекты остаются в зеркале после `dispose`. Блокировка `#mirrors` не нужна: объекты только добавляются, `gc.auto=0`.
  3. `read-tree <parent>`.
  4. `hash-object -w --no-filters --stdin-paths` партиями `siteImportLimits.hashBatchFiles` и `hashBatchBytes`: разбиение как `hashBatches` в `initial-version.ts:55`, функция выносится в `git-workspace/` с параметром `Pick<TakenFile, 'bytes'>` и импортируется обоими. Размер берётся из `TakenFile.bytes`: `compareWithMain` переносит его в `write`.
  5. `update-index --add -z --index-info`: сначала строки удаления `0 0000000000000000000000000000000000000000\t<path>\0`, потом записи: так папка, ставшая файлом, не даёт конфликта D/F.
  6. `ls-files --stage -z` и сверка: `git` молча пропускает путь, который отвергает `core.protectNTFS`. Такие пути идут в `dropped`, другое расхождение — `failed()`.
  7. `write-tree`. Равно дереву `parent` — `null`.
  8. `commit-tree <tree> -p <parent>`, сообщение и `botIdentity(committedAt)` как в `trustedCommitOf`.
  9. `this.fsck(workspace, sha)`, без `GIT_OBJECT_DIRECTORY`: приватный репозиторий видит зеркало через `alternates`.

  Шаг 8 складывает окружения: `{ ...botIdentity(committedAt), GIT_OBJECT_DIRECTORY: objects }`. Сообщение приводится к концу строки так же, как в `trustedCommitOf`, иначе `pushTrustedCommit` соберёт другой SHA.

  Пуш — существующий `pushTrustedCommit` (строки 819–858) с `treeOf: sha`, `parent`, `expected: parent`, тем же `message` и `committedAt`: он собирает тот же SHA, потому что объекты лежат в зеркале и `hasCommits` отвечает без сети. Новой ветки кода пуша нет. Коммита в зеркале нет, а сеть его не нашла — `conflict(…)` из `mirror()` (строка 1568): вызывающий понимает это как `commit_lost`.

  `dropUnreachable`: `repositoryUrl`, пустой приватный каталог, как `readBranchHead` (строки 515–518), затем `this.#mirrors.run(path, …)`: нет зеркала или `!isPristineMirror` — выход; иначе `prune --expire=now` с `GIT_DIR: path`. Это безопасно: система уже переживает пересоздание зеркала, а всё нужное достижимо с удалённых ссылок.

  Запрещено: писать `main` в `hostingCommit`, ставить тег, принимать относительный `blob`, менять `pushTrustedCommit`.
- *Тесты.* Новый файл, транспорт `local-test`, по образцу `git-workspace.tree-export.test.ts`:
  - `leaves the parent's other entries as they are`: дерево — родитель плюс правки, режим `100755` сохраняется, родитель один.
  - `a push after the operation is gone finds the commit in the mirror`: `hostingCommit`, затем `pushTrustedCommit` новым вызовом: `{ status: 'pushed', sha }`, SHA совпал. Падает, если объекты легли в приватный репозиторий. Это главный тест среза.
  - `refuses a push when main moved`: `{ status: 'moved' }`.
  - `no tag is made`: `ls-remote --tags` пуст.
  - `a file where a folder was, and a folder where a file was`.
  - `reports a path git leaves out`: `dropped`.
  - `returns null for the tree of the parent`.
  - `dropUnreachable forgets a commit no ref reaches`: потом `pushTrustedCommit` падает с кодом `CONFLICT`; достижимые коммиты живы.
- *Стенды.* `pnpm gates`, `pnpm verify:gitea` (метод `pushTrustedCommit` без изменений, стенд — контроль).
- *Готово.* Коммит с хостинга собирается, переживает конец операции и отправляется существующим путём.
- *Зависит.* Э2.6: тот же класс, конфликт текстовый.
- *Параллельно.* С Э6а.1–Э6а.3, Э6а.5, Э6а.6.

## Э6а.5. Таблица и барьер

**Э6а.5. `site_code_syncs`, `inflight_sync_id`, отказ `acquire`.**
- *Цель.* База знает об обновлении копии, а аренда сайта уважает его барьер. Строки `site_releases` и значения `LeaseOperation` не появляется (А2). Вход в код пока никто не зовёт.
- *Файлы.*
  - `packages/db/prisma/schema.prisma`: enum, модель, поля `Site`, `PreviewEnvironment`, `SiteLease`, обратные связи `User`.
  - Новая миграция `packages/db/prisma/migrations/20261102100000_site_code_syncs/migration.sql`; метка позже `20261101100100_site_stack_facts` (Э2.1) и `20261031110000_task_mode_dropped` ветки чатов.
  - Новый `packages/domain/src/site-connection/code-sync.ts`, экспорт в `packages/domain/src/site-connection/index.ts`.
  - Новый `packages/domain/src/site-connection/code-sync.test.ts`.
  - Новый `packages/db/src/site-code-sync.ts`, экспорт в `packages/db/src/index.ts`.
  - Новый `packages/db/src/site-code-sync.test.ts`.
  - `packages/db/src/site-leases.ts`, `site-leases.test.ts`.
  - `packages/db/src/enums.test.ts`.
  - `packages/domain/src/ports/turn-runner.ts:96-101` — `SiteLeaseAuthority.inflightSyncId`.
  - `apps/core/src/testing/site-leases.ts` — поле в подделке.
  - `docs/spec.md` §16 — строка `site_code_syncs`, поля `sites`, `site_leases`, `preview_environments`.
- *Договор.*

  ```prisma
  /// Must equal codeSyncStatuses in @repo/domain (checked by a test).
  enum CodeSyncStatus {
    comparing
    ready
    pushing
    pushed
    failed
    cancelled
  }

  /// «Обновить копию сайта» (docs/plan/62-site-stacks.md, Т50): main moves to what the hosting
  /// holds, without a release and without a lease. Compared first, pushed only once confirmed.
  model SiteCodeSync {
    id            String         @id @default(uuid(7)) @db.Uuid
    siteId        String         @map("site_id") @db.Uuid
    status        CodeSyncStatus @default(comparing)
    mainBeforeSha String         @map("main_before_sha") @db.Char(40)
    commitSha     String?        @map("commit_sha") @db.Char(40)
    /// Numbers and up to 200 paths with their kind of change, no content: codeSyncSummarySchema.
    summary       Json?
    requestedBy   String?        @map("requested_by") @db.Uuid
    confirmedBy   String?        @map("confirmed_by") @db.Uuid
    confirmedAt   DateTime?      @map("confirmed_at") @db.Timestamptz(6)
    heartbeatAt   DateTime?      @map("heartbeat_at") @db.Timestamptz(6)
    errorCode     String?        @map("error_code") @db.VarChar(48)
    createdAt     DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
    updatedAt     DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)

    site           Site                 @relation("SiteCodeSyncs", fields: [siteId], references: [id], onDelete: Restrict)
    requester      User?                @relation("CodeSyncRequester", fields: [requestedBy], references: [id], onDelete: SetNull)
    confirmer      User?                @relation("CodeSyncConfirmer", fields: [confirmedBy], references: [id], onDelete: SetNull)
    installedOn    Site[]               @relation("SiteInstalledCodeSync")
    seededPreviews PreviewEnvironment[] @relation("PreviewSeedSync")
    leaseBarrier   SiteLease?           @relation("CodeSyncLeaseBarrier")

    @@unique([siteId], map: "site_code_syncs_active_key", where: raw("status = ANY (ARRAY['comparing'::\"CodeSyncStatus\", 'ready'::\"CodeSyncStatus\", 'pushing'::\"CodeSyncStatus\"])"))
    @@index([siteId, createdAt(sort: Desc)])
    @@index([requestedBy])
    @@index([confirmedBy])
    @@index([status, updatedAt])
    @@map("site_code_syncs")
  }

  // Site:
  /// The last accepted code_sync (Т50): main moved without a release, installed_version did not.
  codeSyncId String?       @map("code_sync_id") @db.Uuid
  codeSync   SiteCodeSync? @relation("SiteInstalledCodeSync", fields: [codeSyncId], references: [id], onDelete: SetNull)
  codeSyncs  SiteCodeSync[] @relation("SiteCodeSyncs")
  @@index([codeSyncId])

  // PreviewEnvironment:
  /// sites.code_sync_id when the seed was taken: an accepted code_sync makes it stale.
  seedSyncId String?       @map("seed_sync_id") @db.Uuid
  seedSync   SiteCodeSync? @relation("PreviewSeedSync", fields: [seedSyncId], references: [id], onDelete: SetNull)
  @@index([seedSyncId])

  // SiteLease:
  /// Durable barrier of a code_sync while it pushes (Т50): acquire refuses while it stands; never
  /// under a deploy or a revert (CHECK site_leases_sync_barrier_check).
  inflightSyncId String?       @unique @map("inflight_sync_id") @db.Uuid
  inflightSync   SiteCodeSync? @relation("CodeSyncLeaseBarrier", fields: [inflightSyncId], references: [id], onDelete: Restrict)
  ```

  ```sql
  -- Обновление копии сайта (docs/plan/62-site-stacks.md, Т50).
  CREATE TYPE "CodeSyncStatus" AS ENUM ('comparing', 'ready', 'pushing', 'pushed', 'failed', 'cancelled');

  CREATE TABLE "site_code_syncs" (
      "id" UUID NOT NULL,
      "site_id" UUID NOT NULL,
      "status" "CodeSyncStatus" NOT NULL DEFAULT 'comparing',
      "main_before_sha" CHAR(40) NOT NULL,
      "commit_sha" CHAR(40),
      "summary" JSONB,
      "requested_by" UUID,
      "confirmed_by" UUID,
      "confirmed_at" TIMESTAMPTZ(6),
      "heartbeat_at" TIMESTAMPTZ(6),
      "error_code" VARCHAR(48),
      "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ(6) NOT NULL,
      CONSTRAINT "site_code_syncs_pkey" PRIMARY KEY ("id")
  );

  CREATE UNIQUE INDEX "site_code_syncs_active_key" ON "site_code_syncs"("site_id")
    WHERE "status" IN ('comparing', 'ready', 'pushing');
  CREATE INDEX "site_code_syncs_site_id_created_at_idx" ON "site_code_syncs"("site_id", "created_at" DESC);
  CREATE INDEX "site_code_syncs_requested_by_idx" ON "site_code_syncs"("requested_by");
  CREATE INDEX "site_code_syncs_confirmed_by_idx" ON "site_code_syncs"("confirmed_by");
  CREATE INDEX "site_code_syncs_status_updated_at_idx" ON "site_code_syncs"("status", "updated_at");

  ALTER TABLE "site_code_syncs"
    ADD CONSTRAINT "site_code_syncs_site_id_fkey" FOREIGN KEY ("site_id")
      REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "site_code_syncs_requested_by_fkey" FOREIGN KEY ("requested_by")
      REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "site_code_syncs_confirmed_by_fkey" FOREIGN KEY ("confirmed_by")
      REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "site_code_syncs_main_before_sha_check"
      CHECK ("main_before_sha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "site_code_syncs_commit_sha_check"
      CHECK ("commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$'),
    ADD CONSTRAINT "site_code_syncs_commit_check"
      CHECK ("status" NOT IN ('ready', 'pushing', 'pushed') OR "commit_sha" IS NOT NULL),
    ADD CONSTRAINT "site_code_syncs_confirmed_check"
      CHECK ("status" NOT IN ('pushing', 'pushed') OR "confirmed_at" IS NOT NULL),
    ADD CONSTRAINT "site_code_syncs_error_check" CHECK (
      ("status" IN ('failed', 'cancelled') OR "error_code" IS NULL)
      AND ("status" <> 'failed' OR "error_code" IS NOT NULL)
      AND ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z_]{1,47}$')
    ),
    ADD CONSTRAINT "site_code_syncs_summary_check" CHECK (
      "summary" IS NULL
      OR (jsonb_typeof("summary") = 'object' AND octet_length("summary"::text) <= 262144)
    );

  ALTER TABLE "sites" ADD COLUMN "code_sync_id" UUID;
  CREATE INDEX "sites_code_sync_id_idx" ON "sites"("code_sync_id");
  ALTER TABLE "sites" ADD CONSTRAINT "sites_code_sync_id_fkey" FOREIGN KEY ("code_sync_id")
    REFERENCES "site_code_syncs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  ALTER TABLE "preview_environments" ADD COLUMN "seed_sync_id" UUID;
  CREATE INDEX "preview_environments_seed_sync_id_idx" ON "preview_environments"("seed_sync_id");
  ALTER TABLE "preview_environments" ADD CONSTRAINT "preview_environments_seed_sync_id_fkey"
    FOREIGN KEY ("seed_sync_id") REFERENCES "site_code_syncs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

  ALTER TABLE "site_leases" ADD COLUMN "inflight_sync_id" UUID;
  CREATE UNIQUE INDEX "site_leases_inflight_sync_id_key" ON "site_leases"("inflight_sync_id");
  ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_inflight_sync_id_fkey"
    FOREIGN KEY ("inflight_sync_id") REFERENCES "site_code_syncs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_sync_barrier_check" CHECK (
    "inflight_sync_id" IS NULL
    OR ("inflight_release_id" IS NULL
      AND ("operation" IS NULL OR "operation" = 'turn'::"LeaseOperation"))
  );
  ```

  Миграция только добавляет: данных не переписывает, порядок запуска обычный.

  ```ts
  // packages/domain/src/site-connection/code-sync.ts
  export const codeSyncStatuses = ['comparing', 'ready', 'pushing', 'pushed', 'failed', 'cancelled'] as const
  export type CodeSyncStatus = (typeof codeSyncStatuses)[number]

  export const codeSyncLimits = Object.freeze({
    /** Comparisons that reached a summary, per site and hour: not an empty one, not a stale one. */
    summariesPerHour: 1,
    /**
     * Comparisons of a site that may fail in a day: attempts, not repeats, the fourth start is refused.
     * Counted since its access to the files last changed: a new access opens the comparison at once.
     */
    failuresPerDay: 3,
    /** A summary nobody accepted is cancelled and its commit dropped after this. */
    unconfirmedMs: 24 * 60 * 60_000,
    summaryPaths: 200,
  })

  /**
   * site_code_syncs.error_code. `auth_failed`, a login the hosting refused, comes with the codes of
   * an import: a comparison is the only way out of `code_drift`, so its text names the way (Т50).
   */
  export const codeSyncErrorCodes = [
    ...provisioningErrorCodes,
    // A folder the hosting would not open: nothing may be called deleted (А11).
    'source_unreadable',
    // `main` left the commit the comparison stood on.
    'main_moved',
    // The mirror no longer has the commit: the comparison is made again.
    'commit_lost',
    // `cancelled`: nothing differs.
    'no_changes',
    // `cancelled`: nobody confirmed within unconfirmedMs.
    'unconfirmed',
    // `cancelled`: a later comparison took its place.
    'superseded',
    // `cancelled`: the client said no.
    'declined',
  ] as const
  export type CodeSyncErrorCode = (typeof codeSyncErrorCodes)[number]

  const pathChange = z.enum(['added', 'modified', 'deleted', 'left_out'])
  export const codeSyncSummarySchema = z.strictObject({
    v: z.literal(1),
    added: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    /** Files that stayed out: a secret, a size, a read that failed. What `main` has of them stays. */
    leftOut: z.number().int().nonnegative(),
    /** Media that differ by size. They are not carried. */
    media: z.number().int().nonnegative(),
    /** What readStack read on the hosting; goes into sites.stack_facts on acceptance. */
    facts: siteStackFactsPatchSchema,
    paths: z
      .array(z.strictObject({ path: z.string().refine(isPublicationPath), change: pathChange }))
      .max(codeSyncLimits.summaryPaths),
    truncated: z.boolean(),
  })
  export type CodeSyncSummary = z.infer<typeof codeSyncSummarySchema>

  export const SITE_CODE_SYNC_JOB = 'site.codeSync'
  export const siteCodeSyncJobSchema = z.strictObject({
    syncId: z.uuid(),
    phase: z.enum(['compare', 'push']),
  })
  export type SiteCodeSyncJob = z.infer<typeof siteCodeSyncJobSchema>
  export const siteCodeSyncDedupeKey = (job: SiteCodeSyncJob): string =>
    `site-code-sync:${job.syncId}:${job.phase}`
  export const siteCodeSyncWakeJobId = (job: SiteCodeSyncJob, tag: string): string =>
    `site-code-sync:${job.syncId}:${job.phase}:wake:${tag}`
  ```

  ```ts
  // packages/db/src/site-code-sync.ts, в этом срезе только барьер
  /**
   * Raises the barrier of a confirmed code_sync, once, in one statement. A site that never ran a
   * turn has no row of site_leases: it gets a free one. false — a release barrier, a holder of a
   * deploy or a revert, expired or not (a release takes an expired lease over, plan 53, R8b), an
   * operator's hold or another sync's barrier.
   */
  export async function raiseSyncBarrier(db: Db, input: { siteId: string; syncId: string }): Promise<boolean>
  /** Lowers it; false — it was not this sync's. */
  export async function lowerSyncBarrier(db: Db, input: { syncId: string }): Promise<boolean>
  /** The run still owns the push: the row is `pushing` and the barrier its own. */
  export async function ownsSyncBarrier(db: Db, input: { syncId: string }): Promise<boolean>
  ```

  ```sql
  -- raiseSyncBarrier
  INSERT INTO site_leases (site_id, epoch, inflight_sync_id, updated_at)
  VALUES (${siteId}::uuid, 0, ${syncId}::uuid, clock_timestamp())
  ON CONFLICT (site_id) DO UPDATE SET
    inflight_sync_id = EXCLUDED.inflight_sync_id, updated_at = EXCLUDED.updated_at
  WHERE NOT site_leases.held_for_operator
    AND site_leases.inflight_release_id IS NULL
    AND site_leases.inflight_sync_id IS NULL
    AND (site_leases.operation IS NULL OR site_leases.operation = 'turn'::"LeaseOperation")
  RETURNING site_id
  ```

  `packages/db/src/site-leases.ts`: в `acquire` (строки 104–108) одно условие `AND site_leases.inflight_sync_id IS NULL`; `rowsSchema` получает `inflight_sync_id: id.nullable()`, `authority` — `inflightSyncId`, в `RETURNING` `acquire` и `renew` и в `SELECT` `inspect` добавляется колонка. `release` и `free` барьера не трогают и не проверяют: держатель `turn` свободно уходит из-под него. `grant` не меняется.

  `apps/core/src/testing/site-leases.ts`: поле `syncBarrier?: string | null`, `acquire` подделки отказывает при нём, `inspect` отдаёт `inflightSyncId`.

  Ходы не меняются: `turn-supervisor.ts:111` при занятом сайте даёт `siteBusy()`, а `#siteRetry` (`pass-runner.ts:476-488`) при строке без держателя ждёт `RETRY_DELAY_MS.site`. Оба места барьер не называют и не должны.

  При слиянии с веткой чатов: её `acquire` меняет только `WHERE t.id … COALESCE`, новое условие стоит в другой части запроса; в `schema.prisma` у неё снята связь `SiteLease.site`, новые поля её не задевают.

  Запрещено: новое значение `LeaseOperation`, запись барьера вне этих функций, поле в `SiteLeaseGrant`.
- *Тесты.*
  - `site-leases.test.ts`: новый `refuses to acquire while a sync barrier stands, even with no holder`. Падает до правки: `acquire` выдаёт аренду.
  - `site-code-sync.test.ts` на базе: барьер встаёт на сайте без строки аренды и строка свободна (`holder_task_id` пуст, эпоха 0); встаёт при живой аренде `turn`, ход её спокойно отпускает; не встаёт при `inflight_release_id`, при `deploy` живом и истёкшем, при `revert`, при `held_for_operator`, при чужом барьере; `lowerSyncBarrier` чужого не снимает.
  - `site-code-sync.test.ts`: CHECK отвергают `ready` без коммита, `failed` без кода, `pushing` без `confirmed_at`, вторую активную строку сайта (`site_code_syncs_active_key`), два барьера в одной строке аренды.
  - `enums.test.ts`: `CodeSyncStatus` равен `codeSyncStatuses`.
  - `code-sync.test.ts` (домен): схема отвергает 201 путь, путь с `..`, неизвестный ключ.
  - Правятся ожидания `toEqual` у `inspect`, если они есть, новым полем `inflightSyncId: null`.
- *Стенды.* `pnpm gates`, `pnpm verify:db` (сверка схемы с миграциями, наборы аренды).
- *Готово.* `verify:db` зелёный, схема совпадает с миграциями, продукт новых таблиц не пишет.
- *Зависит.* Э2.1: метка миграции, `siteStackFactsPatchSchema`.
- *Параллельно.* С Э6а.1–Э6а.4. Другие миграции этапа — нет: они в этом срезе все.

## Э6а.6. Что меняется, потому что `main` сдвинулся

**Э6а.6. Условия Т50, кроме кнопки отмены.**
- *Цель.* Всё, что читает выпуск как единственную причину движения `main`, узнаёт о `code_sync` раньше, чем он сможет случиться (А10). Закрывает пять пунктов Т50: `freshSeed`, `markStaleCandidates`, `siteIsFree`, `copyStillTrue`, `undoReturnsTo`. Шестой, `undoFacts`, — Э6б.1.
- *Файлы.*
  - `packages/db/src/preview-staleness.ts:27`.
  - `apps/core/src/previews/preview-facts.ts:52,66,110,117,165,183`.
  - `apps/core/src/previews/preview-builder.ts:389-398,406-420,568,649,664-666,849`.
  - `packages/db/src/release-undo.ts:184-195`, `release-undo.test.ts`.
  - `apps/core/src/releases/release-outcome.ts`, `packages/trpc/src/services/chat/undo.ts` — только типы клиента, если `Pick` сужен.
  - `packages/trpc/src/services/site-delete.ts:105-120`, его тест.
  - `apps/core/src/previews/preview-facts.test.ts`, `preview-builder.test.ts`, `preview-manager.integration.test.ts`.
- *Договор.*

  ```sql
  -- preview-staleness.ts, вместо строки 27
  AND (p.seed_release_id IS DISTINCT FROM s.installed_release_id
    OR p.seed_sync_id IS DISTINCT FROM s.code_sync_id)
  ```

  ```ts
  // preview-facts.ts
  seed: { key: string; sha256: string; releaseId: string | null; syncId: string | null } | null
  site: { id: string; stack: SiteStack; url: string; installedReleaseId: string | null; codeSyncId: string | null }

  // preview-builder.ts
  /** The seed is a state of production: a release or an accepted code_sync took it away. */
  export const freshSeedOf = (seed: PreviewFacts['preview']['seed'], site: PreviewFacts['site']): boolean =>
    !seed || seed.releaseId !== site.installedReleaseId || seed.syncId !== site.codeSyncId
  ```

  `siteIsFree`: `SELECT` получает `inflight_sync_id`, условие — `… || lease.inflight_release_id || lease.inflight_sync_id`.

  `copyStillTrue`: вход получает `syncId: string | null`; запрос — `s.code_sync_id AS sync`; итог — `row.installed === input.releaseId && row.sync === input.syncId && !row.touched`.

  `PreviewSeedRef` и `aad` (`preview-seed.ts:50,64`) не меняются: прежние семена открываются байт в байт. `seed_sync_id` пишется рядом: `seedSyncId: fresh ? site.codeSyncId : null` в транзакции строк 656–673, `seedSyncId: null` в `failBuild` рядом с `seedReleaseId: null`, `syncId: site.codeSyncId` в объекте `seed` строки 649.

  ```ts
  // packages/db/src/release-undo.ts
  export async function undoReturnsTo(
    db: Pick<Prisma.TransactionClient, 'siteRelease' | 'siteCodeSync'>,
    input: { siteId: string; installedBeforeSha: string | null },
  ): Promise<string> {
    if (input.installedBeforeSha === null) return INITIAL_VERSION_TAG
    const before = await db.siteRelease.findFirst(/* как сейчас */)
    if (before) return before.version
    // The hosting held a commit of a code_sync: the version before it is the last one installed.
    const sync = await db.siteCodeSync.findFirst({
      where: { siteId: input.siteId, commitSha: input.installedBeforeSha, status: 'pushed' },
      select: { confirmedAt: true },
    })
    if (!sync?.confirmedAt) return INITIAL_VERSION_TAG
    const last = await db.siteRelease.findFirst({
      where: { siteId: input.siteId, status: 'installed', createdAt: { lt: sync.confirmedAt } },
      orderBy: { createdAt: 'desc' },
      select: { version: true },
    })
    return last?.version ?? INITIAL_VERSION_TAG
  }
  ```

  Слова «версия с обновлённой копией» здесь не появляются: Р1. Значение остаётся `versionTagSchema` (`client-feed.ts:620,903`).

  `site-delete.ts`: `select` получает `inflightSyncId`, условие занятости — `… || lease.inflightSyncId !== null`, причина прежняя `'lease'`. `site-access-change.ts` не меняется: доступ, заменённый во время пуша, пушу не мешает.

  `undo-planner.ts`, `release-skill.ts`, `candidate-builder.ts`, `task-settle.ts` не меняются: первый откажет сам (`installed_sha` другой, строки 127–138), последний считает `stale` по `installed_sha` (строка 488), а `recordCandidate` держит ту же блокировку `FOR SHARE` на `sites`, которую возьмёт транзакция принятия.

  Запрещено: сбрасывать `installed_version` и `installed_release_id`, менять AAD семени.
- *Тесты.*
  - `preview-builder.test.ts`: `freshSeedOf` на четырёх сочетаниях. `a code_sync takes the seed away` падает до правки: выпуск прежний, семя считается свежим.
  - `preview-manager.integration.test.ts` рядом со строкой 724: `markStaleCandidates` метит кандидата, когда у сайта новый `code_sync_id`. Падает до правки: `seed_release_id` совпадает.
  - там же: `siteIsFree` при `inflight_sync_id` даёт `PreviewLater('site_busy')`; `copyStillTrue` выбрасывает семя, если `code_sync_id` сменился за время копии.
  - `release-undo.test.ts`: выпуск `v1.2.0`, строка `pushed` с `commit_sha = C`, выпуск с `installedBeforeSha = C`: `undoReturnsTo` даёт `v1.2.0`. Падает до правки: `v0.0.0`. Контроль: без выпусков — `v0.0.0`; выпуск, начатый после обновления, не считается.
  - `site-delete` тест: барьер — `'lease'`.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:preview-network`, `pnpm verify:release`: регрессия предпросмотров и отмены.
- *Готово.* Запись `code_sync_id` в базе руками делает семя и кандидатов устаревшими, отмена говорит верный номер.
- *Зависит.* Э6а.5.
- *Параллельно.* С Э6а.1–Э6а.4. С Э6а.10 и Э6а.11 — нет: `preview-builder.ts`.

## Э6а.7. Сравнение и сводка

**Э6а.7. Задание сравнивает хостинг с `main` и показывает итог.**
- *Цель.* Сравнение в очереди `site-import`: те же правила путей, точные значения и gitleaks, полный обход кода, медиа не скачиваются. Строка доходит до `ready` с готовым, но не отправленным коммитом и сводкой. Закрывает А11 («нет в обходе» не значит «удалён») и C21. Вход пока только из тестов.
- *Файлы.*
  - `apps/core/src/site-provisioning/tree-walk.ts`, `tree-walk.test.ts` — что листинг помнит.
  - `apps/core/src/site-provisioning/code-tree.ts` — режим медиа, новые поля итога.
  - Новые `apps/core/src/site-provisioning/code-sync-diff.ts`, `code-sync-diff.test.ts`.
  - Новые `apps/core/src/site-provisioning/code-sync.ts`, `code-sync.test.ts`.
  - `apps/core/src/testing/site-import.ts`: `SiteImportFixture` отдаёт `lastSession()`, тесту нужны `session.reads`.
  - Новый `apps/core/src/site-provisioning/code-sync-store.ts`.
  - Новые `apps/core/src/site-provisioning/code-sync.runner.ts`, `code-sync.runner.test.ts`.
  - Новый `apps/core/src/site-provisioning/run-guard.ts`: `settle` и цикл пульса выносятся из `site-import.runner.ts` (строки 61–92, 227–257) без правок поведения.
  - `apps/core/src/site-provisioning/site-import.processor.ts`, `site-import.processor.test.ts`.
  - `apps/core/src/site-provisioning/site-provisioning.module.ts`, `site-provisioning.module.test.ts`.
  - `packages/db/src/site-code-sync.ts`, `site-code-sync.test.ts`.
  - `packages/domain/src/site-connection/code-sync.ts`, `code-sync.test.ts` — текст сводки.
  - `packages/trpc/src/routers/site-access-change.test.ts` — смена доступа двигает `site_code_sources.updated_at`.
- *Договор.*

  **Листинг.**

  ```ts
  // apps/core/src/site-provisioning/tree-walk.ts
  // ListInput получает:
  /** true — media are only listed: not in `files`, not against the limits of files and bytes. */
  mediaApart?: boolean
  // TreeListing получает:
  /** Media the listing set apart (`mediaApart`). */
  mediaFiles: ListedFile[]
  /** Folders read whole, by repository path; '' — the root. */
  folders: Set<string>
  /** Every name of those folders the policy takes, by what it is. */
  entries: Map<string, 'file' | 'directory' | 'other'>
  /** Files over `fileBytes`. */
  oversized: string[]
  /** Folders the server would not open: part of `skipped.unreadable`, a comparison stops on them. */
  closedFolders: number
  // WalkResult получает:
  /** Files read and dropped for an exact secret, and files that could not be read after the listing. */
  leftOut: string[]
  ```

  Папка попадает в `folders` после удачного `list`, если она не `nested_site`, не `closed_stack` и ни одна её запись не получила `unsupported_path`: такая запись значит, что имя в папке есть, а в пути его нет. Ссылка и `other` пишутся в `entries` как `'other'`. Папка, не открывшаяся или ушедшая наружу (`outside_root`), в `folders` не попадает.

  Файл, который листинг нашёл, а чтение отказало, не останавливает сравнение: `unreadable` — это и файл, исчезнувший после листинга, и файл `0600` другого пользователя хостинга (`tree-walk.ts:117-118,170-178`). Если бы такой файл останавливал сравнение, один кеш-файл плагина ронял бы его, а файл с чужими правами давал бы отказ навсегда: тупик `conflict` остался бы на живых сайтах. Он идёт в `leftOut`, счёт `skipped.unreadable` растёт, как раньше.

  **Дерево с хостинга.** `CodeTreeRun` получает `media: 'take' | 'apart'`: импорт — `'take'`, `code_sync` — `'apart'`. `CodeTree` получает:

  ```ts
  listing: TreeListing
  /** What the walk read and left out: an exact secret, a finding without an original, a size. */
  leftOut: string[]
  /** The objects that judged the walk: a comparison judges `main` by the same ones. */
  policy: ImportPathPolicy
  isMedia: (path: string) => boolean
  ```

  **Разница.** Чистая функция, без git и сети:

  ```ts
  // apps/core/src/site-provisioning/code-sync-diff.ts
  export interface CodeSyncDiffInput {
    main: readonly TreeFile[]
    /** The copies, each with the id git gives its bytes (blobOid). */
    taken: readonly (TakenFile & { oid: string })[]
    listing: Pick<TreeListing, 'folders' | 'entries' | 'mediaFiles'>
    leftOut: readonly string[]
    policy: ImportPathPolicy
    isMedia: (path: string) => boolean
  }
  export interface CodeSyncDiff {
    write: { path: string; blob: string; bytes: number; mode: '100644' | '100755'; change: 'added' | 'modified' }[]
    remove: string[]
    leftOut: string[]
    /** Media that differ by size, in either direction. */
    media: number
    /** The tree after the commit: within `siteImportLimits.files` and `treeBytes`. */
    files: number
    bytes: number
  }
  export function compareWithMain(input: CodeSyncDiffInput): CodeSyncDiff
  ```

  Для файла `f` дерева `main`, первое подошедшее правило:

  | № | Условие | Итог |
  | --- | --- | --- |
  | 1 | `policy.decide(f.path, 'file') !== 'take'` | Остаётся, в сводке нет: пути вне политики остаются в дереве |
  | 2 | `isMedia(f.path)` | Остаётся. На хостинге нет, папка прочитана: `media + 1` |
  | 3 | Есть в `taken`, тот же `oid` | Ничего |
  | 4 | Есть в `taken`, другой `oid` | `modified`, режим `100755` сохраняется, остальное `100644` |
  | 5 | Есть в `leftOut` | Остаётся из `main`, в сводке `left_out` |
  | 6 | `gone(f.path)` | `remove` |
  | 7 | Иначе | Остаётся, в сводке нет: папку не читали |

  ```ts
  /** `path` is gone only if a folder read whole, walking down from the root, shows that. */
  function gone(path: string, listing): boolean {
    const segments = path.split('/')
    let folder = ''
    for (let at = 0; at < segments.length; at += 1) {
      if (!listing.folders.has(folder)) return false      // not read whole
      const name = segments.slice(0, at + 1).join('/')
      const kind = listing.entries.get(name)
      if (kind === undefined) return true                 // the folder has no such name
      if (kind === 'other') return false                  // a link: never followed
      const last = at === segments.length - 1
      if (kind === 'file') return !last                   // a file where main had a folder
      if (last) return true                               // a folder where main had a file
      folder = name
    }
    return false
  }
  ```

  Файл `taken` без строки в `main` — `added`, режим `100644`. Файл `leftOut` без строки в `main` — только в сводке. Медиа из `listing.mediaFiles`: нет в `main` или `bytes !== size` — `media + 1`. `files` и `bytes` считаются по итоговому дереву; сверх `siteImportLimits` — `refuse('source_too_large')`.

  **Запуск.**

  ```ts
  // apps/core/src/site-provisioning/code-sync.ts
  export interface CodeSyncRun {
    id: string
    site: CodeTreeSite
    repo: RepoRef
    /** `git_repositories.default_branch`. Apart from `repo`: strict schemas of `GitWorkspaceService` answer BAD_REQUEST on an extra field. */
    branch: string
    createdAt: Date
  }
  export interface CodeSyncDeps extends CodeTreeDeps {
    store: CodeSyncStore
    git: CodeSyncGit | null
    /** InitialVersionGit.context: the same trusted environment as an import. */
    context: (home: string) => TrustedGitContext
  }
  export type CodeSyncCompared =
    | { kind: 'ready'; commitSha: string; summary: CodeSyncSummary }
    | { kind: 'no_changes'; summary: CodeSyncSummary }
  /**
   * Throws CodeSyncFailure with the code the row gets. ImportFailure takes provisioning codes only, and
   * `source_unreadable` is not one: `store.fail` of the import must not learn it.
   */
  export class CodeSyncFailure extends Error {
    constructor(readonly code: CodeSyncErrorCode) { super(code) }
  }
  /** Throws CodeSyncFailure with the code the row gets; ImportFailure of the shared walk passes through. */
  export function compareSite(run: CodeSyncRun, signal: AbortSignal, deps: CodeSyncDeps): Promise<CodeSyncCompared>
  ```

  Порядок `compareSite`:
  1. Приватный каталог `mkdtemp(join(tmpdir(), CLONE_PREFIX))`, в `finally` удаляется; `assertScanner`. Нет `git` — `refuse('repository_not_configured')`.
  2. `store.readAccess(site.id)`, `checkedAccess`. Статус сайта здесь не проверяется: это делает постановка.
  3. `git.readBranchHead({ repo: run.repo, branch: run.branch })`; `null` — `refuse('repository_mismatch')`. `refuse` здесь свой, он бросает `CodeSyncFailure`; `import-failure.ts`, `provisioningErrorCodes` и `importTexts` не меняются. `store.recordMain(run.id, head)`.
  4. `readCodeTree(…, media: 'apart')`. `onStack` запоминает `reading.patch`, при `reading.refused` бросает `refuse('layout_unsupported')`, а записи в сайт не делает: она идёт при принятии. `onListed` пуст: порог Т49 не действует, медиа не скачиваются.
  5. `listing.closedFolders > 0` — `refuse('source_unreadable')`. `source_inconsistent` приходит из обхода сам. Это остановка А11: папка, которая не открылась, значит, что сервер скрывает её содержимое, коммита нет. Отдельный файл остановкой не служит: он идёт в `left_out` и остаётся из `main`, это вторая половина А11.
  6. `git.treeFiles({ repo, sha: head })`, `blobOid` каждой копии (sha1 от `blob <bytes>\0` и потока файла, функция в `code-sync.ts`).
  7. `compareWithMain`. Нет `write` и `remove` — `no_changes`.
  8. `git.hostingCommit({ repo, parent: head, write: diff.write.map(({ change, ...file }) => file), remove, message: codeSyncMessage(…), committedAt: run.createdAt.toISOString() })`: поле `change` остаётся для сводки, а строгая схема ответила бы BAD_REQUEST на лишнее поле. `null` — `no_changes`. `dropped` уходят из `added` в `left_out`.
  9. Сводка: числа, `facts: reading.patch`, затем пути по порядку `deleted`, `modified`, `added`, `left_out`, внутри по алфавиту, первые `codeSyncLimits.summaryPaths`; `truncated` — если отрезано. Схема проверяет `codeSyncSummarySchema.parse`.

  `created_at` строки — и есть момент коммита: отдельной колонки не нужно, повтор пуша собирает тот же SHA.

  **Хранилище и бегун.**

  ```ts
  // apps/core/src/site-provisioning/code-sync-store.ts
  export interface ClaimedCodeSync extends CodeSyncRun {
    mainBeforeSha: string
    commitSha: string | null
    summary: CodeSyncSummary | null
  }
  export interface CodeSyncStore {
    claim(job: SiteCodeSyncJob): Promise<ClaimedCodeSync | null>
    heartbeat(syncId: string, status: CodeSyncStatus): Promise<boolean>
    readAccess(siteId: string): Promise<StoredAccess>
    recordMain(syncId: string, sha: string): Promise<void>
    ready(syncId: string, commitSha: string, summary: CodeSyncSummary): Promise<void>
    noChanges(syncId: string, summary: CodeSyncSummary): Promise<void>
    fail(syncId: string, code: CodeSyncErrorCode): Promise<void>
  }
  ```

  ```sql
  -- claim
  UPDATE site_code_syncs c SET heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
  FROM sites s
  WHERE c.id = ${syncId}::uuid AND s.id = c.site_id AND s.deleted_at IS NULL
    AND c.status = ${status}::"CodeSyncStatus"
    AND (c.heartbeat_at IS NULL
      OR (c.status = 'pushing' AND c.heartbeat_at < clock_timestamp() - ${staleMs}::int * interval '1 millisecond'))
  RETURNING …
  ```

  `status` — `comparing` для `compare`, `pushing` для `push`. После `claim` репозиторий читается той же первой строкой по `created_at`, что `gitRepository.findFirst` в `pass-facts.ts:166` и `siteRepository` в `undo-planner.ts`: у сайта строк может быть несколько, а `sites.default_branch` нет. Из неё `repo` и `branch` (`git_repositories.default_branch`). Нет строки — `fail('repository_mismatch')`. Второй доставки того же задания нет: `heartbeat_at` уже стоит. Все записи запуска идут с условием `AND status = 'comparing'`: `lease_epoch` нет, строка, которую сборщик закрыл, запись не принимает.

  `CodeSyncRunner.run(job, shutdown)`: `claim`; `null` — `skipped`. Сигнал `AbortSignal.any([lost, shutdown, deadline])`, срок `siteImportLimits.stageMs`, пульс `provisioningLimits.heartbeatMs` и `staleMs` из `run-guard.ts`. Итог:

  | Что вышло | Запись |
  | --- | --- |
  | `ready` | `store.ready`, `status = 'ready'`, `heartbeat_at = NULL` |
  | `no_changes` | `store.noChanges`, `status = 'cancelled'`, `error_code = 'no_changes'`, сводка есть |
  | Сработал `deadline` | `fail('timed_out')` |
  | Сработал `shutdown` | `fail('interrupted')` |
  | `CodeSyncFailure`, `ImportFailure` | `fail(error.code)`, в том числе `transient`: повтора нет. Коды `provisioningErrorCodes` входят в `codeSyncErrorCodes` |
  | Другое | `fail('internal')` |

  Докачки нет (C21): сравнение укладывается в час, упавшее клиент запускает снова. `provisioningLimits.importsPerWorkspace` на сравнение не действует; общий предел — `importConcurrency` процессора. Лог: `site_code_sync_started|ready|failed sync=<id> code=<code>`, без путей.

  **Процессор.** Очередь одна, BullMQ отдаёт задания одному `@Processor`, поэтому выбор — по имени задания:

  ```ts
  async process(job: Job): Promise<void> {
    if (job.name === SITE_CODE_SYNC_JOB) {
      const parsed = siteCodeSyncJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError('Invalid site code sync job')
      await this.#sync.run(parsed.data, this.#shutdown.signal)
      return
    }
    // дальше как сейчас
  }
  ```

  Модуль собирает `CodeSyncRunner` рядом с `SiteImportRunner`: `git` — `GitWorkspaceService | null` из `GitWorkspaceModule`, `stacks: getSiteAdapter`, `closedRoots: closedStackRoots(siteAdapters())`: иначе сравнение скачает ядро закрытого стека из `old/bitrix/` в `added` и в `main`, а импорт такую папку отсекает (факт 14). Запуска фазы `push` в этом срезе нет: `run` с `phase: 'push'` возвращает `skipped`.

  **Постановка.**

  ```ts
  // packages/db/src/site-code-sync.ts
  export type CodeSyncStart = 'allowed' | 'running' | 'hourly_limit' | 'daily_limit' | 'not_allowed' | 'unavailable'
  export interface CodeSyncActor { type: 'user' | 'operator'; id: string }
  /** Whether a comparison may start now, by the rows of the database alone. Э6б.1 reads the same. */
  export function codeSyncStart(db: Reader, input: { siteId: string; userId: string }): Promise<CodeSyncStart>
  /**
   * A summary the site has left behind (Т50): a version was installed after the comparison began,
   * or `main` moved under it and the push said so. It is compared again, outside the hourly limit.
   */
  export function codeSyncStale(
    row: { status: CodeSyncStatus; errorCode: string | null; createdAt: Date },
    site: { installedAt: Date | null },
  ): boolean
  export function requestCodeSync(
    tx: Tx,
    input: { siteId: string; userId: string; actor: CodeSyncActor },
  ): Promise<{ kind: 'started'; id: string } | { kind: 'refused'; reason: Exclude<CodeSyncStart, 'allowed'> }>
  /** The version whose undo is lost on acceptance: installed now, its commit on the site, within 7 days. */
  export function codeSyncUndoLost(db: Reader, input: { siteId: string; now: Date }): Promise<string | null>
  /** Puts the job in the caller's transaction, as enqueueSiteProvisioningStage does. */
  export function enqueueCodeSync(tx: OutboxWriter, job: SiteCodeSyncJob): Promise<boolean>
  ```

  `codeSyncStart`, первое подошедшее:

  | Значение | Условие |
  | --- | --- |
  | `unavailable` | Сайта нет, `deleted_at` стоит, `status <> 'active'`, `installed_sha IS NULL`, нет `site_code_sources`, нет `git_repositories` |
  | `not_allowed` | Роль `userId` не `owner` и не `admin` |
  | `running` | Есть строка `comparing` или `pushing`; `site_leases` с `inflight_release_id` или операцией `deploy`, `revert` |
  | `hourly_limit` | Счётчик `summaries` не меньше `summariesPerHour` |
  | `daily_limit` | Счётчик `failed` не меньше `failuresPerDay`: три упавшие попытки с последней смены доступа к файлам |

  Запрос счётчиков. Договор о нём один, здесь: Э6б.1 только зовёт `codeSyncStart`.

  ```sql
  SELECT
    count(*) FILTER (WHERE c.summary IS NOT NULL AND c.created_at > now() - interval '1 hour'
      AND NOT (c.status = 'cancelled' AND c.error_code IN ('no_changes', 'superseded'))
      AND NOT (c.status = 'failed' AND c.error_code IN ('main_moved', 'commit_lost'))
      AND NOT (c.status = 'ready' AND s.installed_at > c.created_at)) AS summaries,
    count(*) FILTER (WHERE c.status = 'failed' AND c.summary IS NULL
                     AND c.created_at > GREATEST(now() - interval '1 day', a.updated_at)) AS failed,
    count(*) FILTER (WHERE c.status IN ('comparing', 'pushing')) AS running
  FROM site_code_syncs c
  JOIN sites s ON s.id = c.site_id
  JOIN site_code_sources a ON a.site_id = c.site_id
  WHERE c.site_id = $1::uuid
  ```

  Строка `no_changes` несёт сводку, но час не тратит: пустое сравнение не считается запуском, дошедшим до сводки (правка 17), кнопка стоит на «Обзоре». Устаревшая сводка тоже: её условие совпадает с `codeSyncStale`, тест сверяет оба. `superseded` не считается, потому что такую строку сменило новое сравнение, и оно считается само. `sites.installed_at` не пуст: у сайта без него `unavailable`, а `sites_installed_check` держит его вместе с `installed_sha`.

  Предел суток (Т50, Р18, по умолчанию). Сравнить можно 3 раза в сутки: `failuresPerDay` считает попытки, а не повторы, после трёх упавших четвёртый запуск получает `daily_limit`. Считаются только строки, начатые после `site_code_sources.updated_at`: смена доступа к файлам сразу снова открывает сравнение. Строка, начатая до смены и упавшая после, не считается: она шла со старым доступом. Новой колонки нет: `updated_at` — поле `@updatedAt`, строку пишут только `project.create`, `replaceAccess` (`site-connection.ts:314`) и `changeSiteSource` (`site-access-change.ts:360`), каждый после проверки на сервере, а отказанная проверка ничего не пишет. `JOIN` строк не теряет: без `site_code_sources` ответ `unavailable` стоит выше. Пересохранение того же доступа тоже открывает сравнение: это принято, каждая смена идёт через `gatedChecks` и настоящий вход на хостинг.

  `requestCodeSync` в транзакции: `SELECT … FROM sites WHERE id = $1 FOR UPDATE`, затем `codeSyncStart`. Строка `ready` старше часа или устаревшая переходит в `cancelled` с кодом `superseded`: иначе `site_code_syncs_active_key` не пустит новую. Новая строка: `status = 'comparing'`, `main_before_sha = sites.installed_sha` (Р2), `requested_by`. Затем `enqueueCodeSync({ syncId, phase: 'compare' })` и аудит `site.code_sync.request`: `actorType` и `actorId` из `actor`, `meta: { userId }`.

  **Что клиент узнаёт по строке.** Экранов здесь нет, они в Э6б.2, но каждый вид доски обязан читаться из базы без новых колонок:

  | Вид доски | Что в базе |
  | --- | --- |
  | `O-sync-summary`, «Есть изменения» | `ready`, `codeSyncStale` ложно |
  | `O-sync-summary`, «Файлы кода не изменились» | `cancelled`, `no_changes`, сводка есть. Кнопка «Отменить выпуск» на месте: коммита нет. При `summary.leftOut > 0` строки другие, ниже |
  | `O-sync-summary`, «Идёт выпуск» | `ready` и `codeSyncStart` равен `running`. Принятие отвечает `site_busy`, строка остаётся `ready` |
  | `O-sync-summary`, «Сводка устарела» | `codeSyncStale` истинно. «Сравнить ещё раз» — обычный `requestCodeSync` |
  | `O-sync-failed`, «Папки не прочитались» | `failed`, `source_unreadable` |
  | `O-sync-failed`, «Файлы менялись» | `failed`, `source_inconsistent` |
  | `O-sync-failed`, «Доступ не сработал» | `failed`, `auth_failed`. Новый код не нужен: `sessionFailure` отдаёт его как есть (`import-failure.ts:54,61`), текст Т50 уже есть в `savedAccessTexts` (`setup-text.ts`), кнопка «Изменить доступ к файлам» ведёт на `changeSiteSource` (`site-access-change.ts:299`) |
  | `O-sync-failed`, «Попыток больше нет» | `codeSyncStart` равен `daily_limit`. Смена доступа к файлам возвращает `allowed` без новой строки в базе |
  | `O-sync-offer`, «Предел в час» | `codeSyncStart` равен `hourly_limit` |

  **Текст сводки**, чистая функция домена, им пользуются команда и Э6б.2:

  ```ts
  // packages/domain/src/site-connection/code-sync.ts
  export function codeSyncSummaryLines(summary: CodeSyncSummary, undoLost: string | null): string[]
  ```

  При `code = added + modified + deleted`, `media`, `leftOut`:
  - `code > 0`, `media > 0`: «На сайте изменилось {code} файлов кода и {media} загруженных файлов: картинки, документы и другое. Загруженные файлы мы не переносим. Если вы этого не делали, сначала проверьте сайт.»
  - `code > 0`, `media = 0`: «На сайте изменилось {code} файлов кода. Если вы этого не делали, сначала проверьте сайт.»
  - `code = 0`, `leftOut = 0`, `media > 0`: «Файлы кода на сайте не изменились, обновлять копию не нужно. На сайте изменилось {media} загруженных файлов: картинки, документы и другое. Загруженные файлы мы не переносим.»
  - `code = 0`, `leftOut = 0`, `media = 0`: «Файлы кода на сайте не изменились, обновлять копию не нужно.»
  - `code = 0`, `leftOut > 0`: «В остальных файлах кода на сайте изменений нет. {leftOut} файлов сравнить не удалось.», при `media > 0` дальше те же фразы о загруженных файлах. Слов «не изменились» и «обновлять копию не нужно» здесь нет: выпавшие файлы мы не сравнили, и `conflict` на таком файле остаётся (Т50). Значение по умолчанию, Р19; новый текст, ждёт вычитки вместе с Он1.
  - `undoLost !== null` и `code > 0`, второй строкой: «Обновив копию, вы больше не сможете отменить выпуск {feedVersionText(undoLost)}.» При `code = 0` принимать нечего: строки об отмене нет, отмена цела.

  Склонение — `pluralRu` из `packages/domain/src/plural.ts`: «изменился 1 файл кода», «изменилось 2 файла кода», «изменилось 214 файлов кода»; «1 загруженный файл», «2 загруженных файла», «1 200 загруженных файлов»; «1 файл сравнить не удалось», «3 файла сравнить не удалось», «5 файлов сравнить не удалось». Слова «картинок» здесь нет: у WordPress в этом счёте есть стили, шрифты и звук (Э6а.2). Тысячи через неразрывный пробел, как `groupDigits` (`client-feed-labels.ts:40`; функция не экспортирована, файл меняет ветка чатов, поэтому своя строка рядом).

  Запрещено: коммит при папке, которая не открылась; удаление по отсутствию в обходе без `gone`; скачивание медиа; `git push` в этом срезе; `summary` с содержимым файлов; условия по имени стека.
- *Тесты.*
  - `code-sync.test.ts`: папка закрытого стека на хостинге не читается, её файлов нет в `added`. Падает до правки: `closedRoots` не передан.
  - `code-sync-diff.test.ts`, таблица на каждую строку правил и на `gone`: папка, которой нет, удаляет файлы, если её родитель прочитан; папка-ссылка не удаляет; папка с `nested_site` не удаляет; папка с `unsupported_path` не удаляет; файл с секретом остаётся; файл сверх размера остаётся; `.gitea/x` и путь `exclude` не трогаются; медиа не попадает в `write` и считается и при изменении размера, и при удалении.
  - `code-sync.test.ts`, фикстура `siteImportFixture` после настоящего импорта и настоящего git:
    - `a folder the hosting would not show stops the comparison and commits nothing`: папка с `fails: 'access_denied'`; код `source_unreadable`, `commitSha` нет. Главный тест А11: падает, если проверки шага 5 нет, потому что файлы папки попадают в `remove`.
    - `a file left out for a secret stays from main and is shown`.
    - `a file gone after the listing does not stop the comparison`: файл удалён между `list` и `read`: итог `ready`, файл в `left_out`, в `remove` его нет. Файл с отказом чтения `access_denied` — то же. Падает при проверке `skipped.unreadable > 0`.
    - `media are not read`: в `session.reads` нет путей `wp-content/uploads/`, `summary.media` равен числу изменённых по размеру.
    - `the commit has main as its only parent and nothing moved on the remote`.
    - `nothing differs: no commit, no_changes`.
    - `a file left out of an empty comparison is not called unchanged`: файл с находкой изменён на хостинге, других отличий нет: итог `no_changes`, `summary.leftOut` равен 1, `codeSyncSummaryLines` не содержит «не изменились». Падает, если ветка `code = 0` не смотрит на `leftOut`.
    - `a login the hosting refuses ends the comparison with auth_failed`: узел дерева с `fails: 'auth_failed'`, как в `tree-walk.test.ts:181`; `compareSite` бросает отказ с этим кодом, коммита нет. Падает, если сбой входа уходит в `internal`: клиент получил бы сбой без текста и выхода.
    - `.php` под `wp-content/uploads/` прочитан и попал в сводку.
  - `code-sync.runner.test.ts`: исходы таблицы, вторая доставка — `skipped`, потеря пульса прерывает запуск.
  - `site-import.processor.test.ts`: `site.codeSync` идёт в `CodeSyncRunner`, неверная нагрузка — `UnrecoverableError`.
  - `site-code-sync.test.ts`: `requestCodeSync` на каждое значение таблицы; предел в час не считает упавшее; после трёх упавших за сутки четвёртый запуск отказан; `ready` старше часа заменяется; участник без прав отказан.
  - `site-code-sync.test.ts`, правка 17:
    - `an empty comparison does not spend the hour`: строка `cancelled`, `no_changes`, сводка есть, следующий `codeSyncStart` — `allowed`. Падает, если счётчик берёт все строки со сводкой.
    - `a stale summary is compared again within the hour`: строка `ready` моложе часа, `sites.installed_at` позже её `created_at`: `allowed`, `requestCodeSync` переводит её в `superseded`. Контроль: без новой версии — `hourly_limit`.
    - `main_moved` и `commit_lost` час не тратят, `failed` суток не считает: у них есть сводка.
    - `auth_failed` без сводки считается в сутках и не считается в часе.
    - `codeSyncStale` совпадает с условием запроса на тех же строках.
  - `site-code-sync.test.ts`, предел суток (Т50, Р18):
    - `a new access to the files opens the comparison at once`: три строки `failed`, `auth_failed`, `codeSyncStart` — `daily_limit`; `site_code_sources.updated_at` позже их `created_at`: `allowed`, `requestCodeSync` ставит новую строку. Контроль: `updated_at` раньше строк — `daily_limit`. Падает, если счётчик смотрит только на сутки.
    - `a failure before the change does not count`: одна упавшая строка до смены и две после: `allowed`; третья после смены: `daily_limit`.
  - `site-access-change.test.ts`: `changeSource` двигает `site_code_sources.updated_at`; проверка, которой отказал сервер, его не двигает. Падает, если запись источника уйдёт в запрос без `@updatedAt`.
  - `code-sync.test.ts` домена: пять строк текста дословно, 1 файл, 2 файла, 1 200 загруженных файлов с неразрывным пробелом; при `code = 0` строки об отмене нет и при `undoLost !== null`; при `code = 0`, `leftOut: 3` строка «В остальных файлах кода на сайте изменений нет. 3 файла сравнить не удалось.», `leftOut: 1` и `leftOut: 5` склоняются, слов «не изменились» нет и при `media > 0`.
  - `tree-walk.test.ts`: `folders` и `entries` на дереве с ссылкой, вложенной установкой, папкой `closed_stack` и именем `unsupported_path`; `closedFolders` считает только папки; `mediaApart` не считает медиа в `files` и `treeBytes`.
  - Существующие тесты `site-import.runner.test.ts` проходят без правок: пульс вынесен, поведение то же.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:site-import` (импорт не задет).
- *Готово.* Строка, поставленная тестом, доходит до `ready`, коммит лежит в зеркале, удалённый `main` не сдвинут. Пустое сравнение и устаревшая сводка час не тратят, отказ входа кончается `auth_failed`, смена доступа к файлам снова открывает сравнение, сводка при выпавших файлах не говорит «не изменились», каждый вид досок `O-sync-summary` и `O-sync-failed` читается из базы.
- *Зависит.* Э6а.2, Э6а.3, Э6а.4, Э6а.5.
- *Параллельно.* С Э6а.6, Э6а.10, Э6а.11.

## Э6а.8. Принятие и сборщик

**Э6а.8. Подтверждение, пуш, запись, уборка.**
- *Цель.* Подтверждённое обновление двигает `main` одной транзакцией вместе с записью сайта и снятием барьера, а сбой между пушем и транзакцией подбирает сборщик (Т50).
- *Файлы.*
  - `packages/db/src/site-code-sync.ts`, `site-code-sync.test.ts`.
  - `apps/core/src/site-provisioning/code-sync.ts`, `code-sync.test.ts` — `pushCodeSync`.
  - `apps/core/src/site-provisioning/code-sync.runner.ts`, `code-sync.runner.test.ts`.
  - Новые `apps/core/src/site-provisioning/code-sync-sweep.ts`, `code-sync-sweep.test.ts`.
  - Новый `apps/core/src/site-provisioning/code-sync-store.integration.test.ts`.
  - `apps/core/src/site-provisioning/site-import.sweeper.ts`, `site-import.sweeper.test.ts`.
  - `apps/core/src/site-provisioning/site-provisioning.module.ts`.
- *Договор.*

  ```ts
  // packages/db/src/site-code-sync.ts
  export type CodeSyncConfirm =
    | { kind: 'pushing' }                                   // сейчас или уже: повтор ничего не пишет
    | { kind: 'site_busy' }                                 // барьер не встал: строка осталась `ready`
    | { kind: 'refused'; status: CodeSyncStatus }
    | { kind: 'not_allowed' }
    | { kind: 'not_found' }
  export function confirmCodeSync(tx: Tx, input: { syncId: string; userId: string; actor: CodeSyncActor }): Promise<CodeSyncConfirm>
  export function cancelCodeSync(tx: Tx, input: { syncId: string; userId: string; actor: CodeSyncActor }): Promise<CodeSyncConfirm>
  /** The second half of a push, once: false — the row is not `pushing`. */
  export function settleCodeSync(tx: Tx, input: { syncId: string }): Promise<boolean>
  /** Ends a row with its code; the barrier of a `pushing` row goes with it, and the waiting passes wake. */
  export function failCodeSync(tx: Tx, input: { syncId: string; code: CodeSyncErrorCode }): Promise<boolean>
  ```

  `confirmCodeSync`, в транзакции: `SELECT … FROM site_code_syncs WHERE id = $1 FOR UPDATE`. Нет строки — `not_found`. `pushing` или `pushed` — `{ kind: 'pushing' }`, записи нет. Не `ready` — `refused`. Роль не `owner` и не `admin` — `not_allowed`. `created_at` старше `unconfirmedMs` — строка становится `cancelled`, `unconfirmed`, ответ `refused`. `raiseSyncBarrier` вернул `false` — `site_busy`, строка остаётся `ready`: отказ при идущем выпуске оставляет сводку, и клиент принимает её, когда выпуск закончится. Иначе `status = 'pushing'`, `confirmed_by`, `confirmed_at = clock_timestamp()`, `heartbeat_at = NULL`, `enqueueCodeSync({ syncId, phase: 'push' })`, аудит `site.code_sync.confirm` с числами сводки, без путей.

  Отдельного условия на устаревшую сводку здесь нет: выпуск сдвинул `main`, пуш ответит `moved`, строка станет `failed`, `main_moved`, а это тот же вид «Сводка устарела».

  `cancelCodeSync`: только из `ready`, `status = 'cancelled'`, `error_code = 'declined'`, аудит `site.code_sync.cancel`.

  `settleCodeSync`, порядок внутри транзакции обязателен, потому что `recordCandidate` читает `sites` `FOR SHARE` (`task-settle.ts:473-476`):
  1. `UPDATE site_code_syncs SET status = 'pushed', heartbeat_at = NULL, updated_at = clock_timestamp() WHERE id = $1 AND status = 'pushing' RETURNING site_id, commit_sha, summary`. Нет строки — `false`.
  2. Запись сайта:

     ```sql
     UPDATE sites SET installed_sha = ${commitSha}, installed_at = clock_timestamp(),
       code_sync_id = ${syncId}::uuid, updated_at = clock_timestamp()
     WHERE id = ${siteId}::uuid
     ```

     `installed_version` и `installed_release_id` не трогаются: номер следующего выпуска не сгорает. CHECK `sites_installed_check` это принимает.
  3. `mergeSiteStackFacts(tx, siteId, summary.facts)`: версия в записи сайта. Сводка другой формы — `{}`. Пустая часть запроса не делает, ключи чтения `unknown` не стираются (Э2.8).
  4. `markSiteCandidatesStale(tx, { siteId, exceptTaskId: null })`.
  5. `lowerSyncBarrier(tx, { syncId })`.
  6. `enqueueSiteWaitingPasses(tx, { siteId, tag: `sync-${syncId}` })`: тег проходит `wakeTagSchema` (`chat-outbox.ts:56`).
  7. Аудит `site.code_sync.pushed`, `actorType: 'system'`, числа сводки.

  Новую пробу после принятия (Т24) дописывает в эту транзакцию Э7.7: `requestSiteProbe` появляется там.

  ```ts
  // apps/core/src/site-provisioning/code-sync.ts
  export type CodeSyncPushed = 'pushed' | 'main_moved' | 'commit_lost'
  export async function pushCodeSync(run: ClaimedCodeSync, deps: CodeSyncDeps): Promise<CodeSyncPushed> {
    const message = codeSyncMessage({ syncId: run.id, siteId: run.site.id })
    try {
      const pushed = await deps.git.pushTrustedCommit(
        {
          repo: run.repo,
          treeOf: run.commitSha,
          parent: run.mainBeforeSha,
          message,
          committedAt: run.createdAt.toISOString(),
          branch: run.branch,
          expected: run.mainBeforeSha,
        },
        () => deps.store.assertBarrier(run.id),
      )
      return pushed.status === 'moved' ? 'main_moved' : 'pushed'
    } catch (error) {
      if (isDomainError(error) && error.code === 'CONFLICT') return 'commit_lost'
      throw error
    }
  }
  ```

  `CodeSyncStore` получает `assertBarrier(syncId)` (`ownsSyncBarrier`, иначе `LeaseLost`), `settle(syncId)` и `fail` с `failCodeSync`.

  Бегун, фаза `push`: `pushed` — `settle`; `main_moved` и `commit_lost` — `fail` с этим кодом; брошенная ошибка строку не меняет, она остаётся `pushing` для сборщика. Ни при каких исходах тег не ставится: правило 6 запускает выкладку только по тегу `v*`.

  ```ts
  // apps/core/src/site-provisioning/code-sync-sweep.ts
  export class CodeSyncSweep {
    /** One pass, every step on its own; never rejects. */
    sweep(): Promise<void>
  }
  ```

  Шаги, партиями по 20 строк, `heartbeat`-правила как у импорта:

  | Шаг | Какие строки | Что происходит |
  | --- | --- | --- |
  | 1 | `comparing`, `heartbeat_at < now() - staleMs` | `fail('interrupted')` |
  | 2 | `comparing`, `heartbeat_at IS NULL`, `updated_at < now() - queuedStaleMs` | Задание `compare` прямо в BullMQ: `siteCodeSyncWakeJobId(job, <пятиминутная метка>)`, как `wakeImport` |
  | 3 | `ready`, `created_at < now() - unconfirmedMs` | `cancelled`, `unconfirmed` |
  | 4 | `pushing`, `heartbeat_at < now() - staleMs`, либо `heartbeat_at IS NULL` и `updated_at < now() - queuedStaleMs` | `readBranchHead`. Голова `commit_sha` — `settleCodeSync`. Голова `main_before_sha` и `confirmed_at` моложе `siteImportLimits.stageMs` — задание `push` тем же способом. Голова `main_before_sha` и строка старше — `fail('repository_push_failed')`. Другая голова — `fail('main_moved')`. Чтение упало — строка ждёт следующего прохода |
  | 5 | `failed` или `cancelled`, `commit_sha IS NOT NULL`, и у сайта нет строки `comparing`, `ready`, `pushing` | `git.dropUnreachable({ repo })`, затем `commit_sha = NULL` |

  Условие шага 5 обязательно: `prune` снёс бы и чужой неподтверждённый коммит того же сайта. Для строки `pushed` объект достижим с `main`, шаг её не касается.

  `SiteImportSweeper` не получает своего таймера: в конец `#sweep()` идёт `await this.#options.codeSync?.sweep()`, опция необязательная, чтобы тесты и `verify:site-import` прежних сценариев работали как были.

  `release.prepare`, `candidate.rebase` и выпуск не меняются: `pushTrustedCommit` выпуска идёт по CAS и увидит сдвинутый `main`, а новый выпуск, вошедший раньше, не даст поднять барьер.

  Запрещено: писать `installed_version`, менять `sites` вне `settleCodeSync`, держать барьер дольше строки `pushing`, отправлять что-либо из сборщика, кроме шагов таблицы.
- *Тесты.*
  - `code-sync-store.integration.test.ts` на PostgreSQL, идёт в наборе `core`:
    - `the push and the site move together, the barrier goes, the passes wake`.
    - `a candidate of every dialog goes stale, the seed of a preview is stale`: падает, если шаг 4 пропущен; `markStaleCandidates` этого не делает для диалога без семени.
    - `installed_version and installed_release_id stay, stack_facts.cmsVersion moves`.
    - `confirm twice writes once`.
    - `a release that holds the site refuses the barrier: site_busy, the row stays ready`.
    - `acquire waits for the barrier and the waiting pass wakes`.
  - `code-sync-sweep.test.ts`: каждая строка таблицы; шаг 4 на настоящем git из фикстуры: голова равна коммиту — `settle`, голова прежняя — задание, другая — `main_moved`; шаг 5 не зовёт `dropUnreachable`, пока у сайта есть `ready`.
  - `code-sync.test.ts`: `a confirmed push moves main, tags nothing, keeps the parent`: `ls-remote --tags` без нового тега. `main moved under the summary`: `main_moved`, коммита на удалённом нет, барьер снят.
  - `site-import.sweeper.test.ts`: опция зовётся, её сбой не роняет проход импорта.
- *Стенды.* `pnpm gates`, `pnpm verify:db`.
- *Готово.* В тестах подтверждённая строка доходит до `pushed`; `kill` между пушем и транзакцией подбирается сборщиком.
- *Зависит.* Э6а.6, Э6а.7.
- *Параллельно.* С Э6а.10, Э6а.11.

## Э6а.9. Команда `sites:sync`, стенды М4б, правило 3

**Э6а.9. Вход для рубежа 1 и доказательство на WordPress.**
- *Цель.* Ядро запускается командой оператора, тупик `conflict` снимается на стенде, и на WordPress тоже (факт 13). Правило 3 становится правдой. Закрывает выход этапа: «М4б на стенде, и на WordPress; отказ по размеру до скачивания».
- *Файлы.*
  - Новый `apps/core/src/site-provisioning/operator-cli.ts`, `operator-cli.test.ts`.
  - Новый `apps/core/scripts/sites-sync.mjs`.
  - `.dependency-cruiser.cjs`: новое правило `core-operator-cli-no-nest`, `apps/core/src/*/operator-cli.ts` не достигает `*.module.ts` и `@nestjs/*`, как `llm-operator-cli-no-nest`: команду Node запускает из исходников, а `site-provisioning/operator-cli.ts` лежит рядом с модулями и декораторами; vitest со swc такой импорт пропустит, упадёт только образ.
  - `infra/app/ci.test.mjs`: фраза о `code_sync` есть в правиле 3 (просьба 61-8).
  - `apps/core/package.json`: `"sites:sync": "node scripts/sites-sync.mjs"`.
  - `infra/app/verify-images.test.mjs:181` — `sites-sync.mjs` в списке `core`.
  - `.dockerignore:22` — имя в комментарии об оставшихся командах.
  - `infra/dev/release-verify/scenarios.mjs`, `README.md`.
  - `infra/dev/site-import-verify/scenarios.mjs`, `verify-site-import.mjs`, `README.md`.
  - `CLAUDE.md` (правило 3: срез вписывает текст §6 при значении вопроса 14, это смена правила, она названа там и в вопросе 21), `docs/spec.md`, §10.
- *Договор.*

  ```text
  pnpm --filter core sites:sync -- start  <siteId> --by <email> [--operator <имя>]
  pnpm --filter core sites:sync -- show   <syncId>
  pnpm --filter core sites:sync -- accept <syncId> --by <email> [--operator <имя>]
  pnpm --filter core sites:sync -- cancel <syncId> --by <email> [--operator <имя>]
  ```

  Устройство — как `apps/core/src/releases/operator-cli.ts`: строгий разбор до чтения окружения, `--help`, `APP_ENV` и `DATABASE_URL` явно, `.env` не читается, только постоянные тексты, `OperatorCommandError`. Код без декораторов и `enum`: Node запускает его из исходников. Импортирует только `@repo/db`, `@repo/domain`, `zod`, `node:os`.

  `--by` — почта пользователя, чьим решением идёт команда: `users.email`, роль `owner` или `admin` рабочего пространства сайта, иначе отказ. `--operator` — имя для аудита, без него имя пользователя ОС, как `operatorName`. Аудит: `actor: { type: 'operator', id: <имя> }`, в `meta` id пользователя.

  Тексты вывода:

  | Случай | Текст |
  | --- | --- |
  | `start`, принято | `Сравнение {syncId} начато. Статус смотрите командой show.` |
  | `running` | `Сравнение или выпуск уже идут. Ничего не изменено.` |
  | `hourly_limit` | `Сравнение уже делали в этот час. Посмотрите его сводку командой show.` |
  | `daily_limit` | `Сравнение трижды за сутки упало. Проверьте доступ к хостингу.` |
  | `not_allowed` | `У этого пользователя нет прав на обновление копии.` |
  | `unavailable` | `Этот сайт нельзя обновить: он не подключён или у него нет доступа к файлам.` |
  | `show` | Статус, код ошибки, строки `codeSyncSummaryLines(summary, codeSyncUndoLost(…))`, затем пути сводки по строке |
  | `show`, `codeSyncStale` истинно | Первой строкой `Сводка устарела: сайт менялся после этого сравнения. Запустите сравнение ещё раз.` |
  | `accept`, `pushing` | `Принято. Core отправит коммит в main и освободит сайт.` |
  | `site_busy` | `Сайт занят выпуском или оператором. Сводка осталась, повторите позже.` |

  Это тексты оператора, клиент их не видит.

  **`verify:release`, сценарий S11** (WordPress, идёт после S10 перед S7). Команда зовётся из приватной копии дерева с `operatorEnvironment(context)`, как `setup.mjs:461`. Правка на хостинге — `site.files.write`, как `undoTrap`.

  | Шаг | Что проверяется |
  | --- | --- |
  | S11a | Диалог меняет строку в `STYLE_PATH`, файл на хостинге правится рядом, `/release` кончается отказом шага `conflicts` до записи файлов, `main` не сдвинут, повторный `/release` даёт тот же отказ: тупик воспроизведён |
  | S11b | `sites:sync start`, `ready`: `modified` содержит `STYLE_PATH`; картинка и файл `wp-content/uploads/elementor/css/post-1.css`, добавленные на хостинге, есть только в `media`, в `added` их нет. На удалённом `main` прежний. Второй `start` — `hourly_limit` |
  | S11c | `accept`: `pushed`; голова `main` — `commit_sha`; один родитель; трейлер `Raditi-Sync`; нового тега нет, `runsOf` новых заданий не показал; `installed_sha` равен коммиту, `installed_version` и `installed_release_id` прежние; файлы хостинга не менялись; кандидат диалога `stale` |
  | S11d | «Обновить», затем `/release`: `installed`, правка хостинга на месте, номер следующий, а не сгоревший. Тупик снят |
  | S11e | «Отменить выпуск» этого выпуска показывает `returnsTo`, равный версии до `code_sync`, а не `v0.0.0` |
  | S11f | `release.undoPlan` выпуска до `code_sync` кончается `undo_outdated` |

  На новых стеках те же шаги идут сценарием R8, срез Э6а.12.

  **`verify:site-import`, сценарии C1–C4** (настоящие SFTP и FTPS, Gitea, `core` из сборки):

  | Сценарий | Что проверяется |
  | --- | --- |
  | C1 unreadable | У папки темы на хостинге снято чтение. По SFTP и по FTPS: `failed`, `source_unreadable`, коммита нет, в `main` ни один файл папки не тронут. Чтение вернули, повтор сразу, файлы на месте. Это А11 на настоящих серверах |
  | C2 removed | Папка плагина удалена на хостинге целиком, рядом файл с паролем сайта. `ready`: файлы папки в `deleted`, файл с паролем в `left_out`, в git его нет, в дампе базы и логах его содержимого нет |
  | C3 kill | `accept`, `kill -9 core`, запуск. Строка доходит до `pushed` не дольше `staleMs` плюс `sweepMs`, барьер снят, транзакция прошла ровно один раз |
  | C4 chmod | У одного файла темы на хостинге снято чтение, папка открывается. По SFTP и по FTPS: `ready`, файл в `left_out`, в `main` он на месте. Настоящий путь «файл нельзя прочитать»; исчезновение между листингом и чтением держит `code-sync.test.ts` |

  **Документы.** В правиле 3 `CLAUDE.md` после «`main` всегда равен установленной версии» дописывается текст из §6 проекта, дословно:

  > Кроме выпуска, `main` двигает только обновление копии сайта (`code_sync`). Его запускает и подтверждает клиент, увидев, что изменилось на хостинге. Оно берёт код с хостинга по правилам импорта и пишет коммит без тега `v*`, поэтому на сайт ничего не выкладывает. Файл, который не удалось прочитать, из `main` не удаляется. После обновления прежний выпуск отменить нельзя, и клиент слышит это до подтверждения.

  В `CLAUDE.md` ещё: команда `sites:sync` в разделе «Команды»; `apps/core/src/site-provisioning/operator-cli.ts` в списке кода, который Node запускает из исходников; число команд оператора в строке `verify:images` (шесть → семь). `docs/spec.md`: раздел 10 — новый подраздел «Обновление копии (`code_sync`)», строка `spec:1228` получает оговорку о `code_sync`; раздел 7, строка 380 — барьер; раздел 12 — листинг; раздел 20 — запись принятых значений с пометкой «по умолчанию», вопрос 14.

  Запрещено: команде писать `main`, Vault или хостинг: она только зовёт функции `@repo/db`.
- *Тесты.* `operator-cli.test.ts`: разбор, отказы разбора до окружения, `--help`, каждый текст таблицы по исходу функции `@repo/db`. Падает до правки: файла нет. `infra/app/verify-images.test.mjs`: список скриптов `core` со `sites-sync.mjs`; контракт `ci.test.mjs` проверяет, что скрипт пакета существует, если его назовёт workflow.
- *Стенды.* `pnpm gates`, `pnpm verify:db`, `pnpm verify:release` (S11), `pnpm verify:site-import` (C1–C4), `pnpm verify:images`, `pnpm verify:gitea`.
- *Готово.* На стенде выпуск, заведённый в `conflict` правкой на хостинге, проходит после `sites:sync`. Числа проверок обоих стендов записаны в их README и `CLAUDE.md`.
- *Зависит.* Э6а.8.
- *Параллельно.* Не рядом с другими стендами Docker: `verify:release` не идёт вместе со стендами ветки чатов (§5.3 проекта).

## Э6а.10. Дрейф

**Э6а.10. Сборка со свежей копией сверяет версию и имена папок с `main`.**
- *Цель.* Т17: файл версии сравнивается с `main` побайтно, имена папок расширений — с деревом `main`. Сборку дрейф не останавливает. Итог лежит в `PreviewRecord.drift`, откуда его берут паспорт и `/release` в Э7 (`62-slices/after.md`, Э7.1).
- *Файлы.*
  - Новый `apps/core/src/previews/preview-drift.ts`, `preview-drift.test.ts`.
  - `apps/core/src/previews/preview-record.ts:30-50`, `preview-record.test.ts`.
  - `apps/core/src/previews/preview-builder.ts`: `PreviewGit` (строки 68–76, `+ readFile`, `listDirectory`), `RootReading` и `readSiteRoot` (Э2.9), `buildPreviewOn`.
  - `apps/core/src/testing/previews.ts`: подделка `git`.
- *Договор.*

  ```ts
  // apps/core/src/previews/preview-record.ts
  export const previewDrifts = ['none', 'version', 'folders', 'unknown'] as const
  export type PreviewDrift = (typeof previewDrifts)[number]
  // previewRecordSchema
  /** What the last fresh seed found against `main` (Т17); absent — a record from before it. */
  drift: z.enum(previewDrifts).optional(),

  // apps/core/src/previews/preview-drift.ts
  export interface DriftInput {
    repo: RepoRef
    mainSha: string
    probe: SiteDriftProbe | null
    policy: ImportPathPolicy
  }
  /** What the hosting shows, read in the session of readSiteRoot; null — the read failed. */
  export interface HostingDrift { version: Uint8Array; folders: Readonly<Record<string, readonly string[]>> }
  /** Never throws but for an aborted signal: a failed read must not lose the rest of readSiteRoot. */
  export async function readHostingDrift(
    tree: SiteTree, probe: SiteDriftProbe, policy: ImportPathPolicy, signal: AbortSignal,
  ): Promise<HostingDrift | null>
  /** After the hosting's session: git does not wait inside its one minute. */
  export async function compareDrift(
    hosting: HostingDrift | null,
    git: Pick<PreviewGit, 'readFile' | 'listDirectory'>,
    input: DriftInput,
    signal: AbortSignal,
  ): Promise<PreviewDrift>
  ```

  Порядок:
  1. `probe === null` — `'none'`: стеку нечего сверять, хостинг не читается.
  2. `readHostingDrift`: `tree.read(probe.versionFile)`; по каждому корню `probe.extensionRoots`, путь без `/` на конце, `tree.list(root)`. `null` на любом чтении — итог `null`. Из записей остаются `type === 'directory'` и `policy.decide(`${root}/${name}`, 'directory') === 'take'`: папка, которую импорт не берёт, никогда не будет в `main`, и дрейф стоял бы вечно.
  3. `compareDrift`, вне сеанса: `hosting === null` — `'unknown'`. `git.readFile` по `mainSha`: `null` — `'unknown'`, байты разные — `'version'`. `git.listDirectory` каждого корня: `null` в `main` — пустой список; наборы имён разные — `'folders'`.
  4. Иначе `'none'`. `version` важнее `folders`.
  5. Любая ошибка — `'unknown'`; при отменённом сигнале — `signal.throwIfAborted()`.

  Чтение хостинга идёт в том же сеансе, что `databaseSettings` и `readStack`: Э2.9 запрещает второй `withRoot` на сборку. Git в этот сеанс не входит: срок сеанса 60 секунд (`site-sources.ts:103`) прежний, чтений стало больше, а истёкший срок роняет то, что ещё не прочитано.

  ```ts
  // preview-builder.ts
  interface RootReading {
    settings: SiteDatabaseSettings | null
    stack: StackReading | null
    /** null — this build takes no fresh seed, the stack has no probe, or the hosting was not read. */
    drift: HostingDrift | null
  }
  // readSiteRoot(deps, adapter, site, driftInput: DriftInput | null, signal)
  // в колбэке withRoot, после stack:
  //   drift: driftInput?.probe ? await readHostingDrift(tree, driftInput.probe, driftInput.policy, signal) : null

  // buildPreviewOn, до readSiteRoot: голова main нужна только свежей копии, кандидату без неё
  // запроса к Gitea сегодня нет, и его сбой не должен ронять такую пересборку
  const mainSha = !freshSeed ? null : candidate
    ? await git.readBranchHead({ repo, branch: facts.repo.defaultBranch })
    : headSha
  const rules = adapter.importRules({ stack: site.stack, url: site.url, docroot: '/', extras: {} })
  const driftInput = mainSha
    ? { repo, mainSha, probe: adapter.driftProbe,
        policy: importPolicyOf(rules) }
    : null
  // после чтения, внутри if (freshSeed), до storePreviewSeed
  record = { ...record, drift: driftInput
    ? await compareDrift(root?.drift ?? null, deps.git, driftInput, signal) : 'unknown' }
  ```

  Сравнение идёт с `main`, а не с головой кандидата: кандидат сам меняет файлы. `importRules` берётся с `extras: {}`, как в импорте: контрактный тест Э2 требует одного ответа. Сборка без свежей копии запись не меняет.

  Показа клиенту, `code_drift` в паспорте, отказа `/release` здесь нет: это Э7 и Э6б. `unknown` Э7 читает как `none`: тип `drift` в `CandidateReadinessInput` (§2.3) значения `unknown` не знает, а сбой чтения сборку и выпуск не останавливает.

  Запрещено: останавливать сборку; сравнивать содержимое папок; разбирать номер версии; читать файлы сверх `probe`.
- *Тесты.* `preview-drift.test.ts` с подделками `SiteTree` и `git`:
  - `the version file differs by one byte`: `'version'`. Падает до правки: файла нет.
  - `a new extension folder`: `'folders'`; `a folder the import leaves out`: `'none'`.
  - `a read that fails is unknown and throws nothing`.
  - `no probe`: `'none'`, хостинг не читался.
  - `git reads go after the hosting's session`: подделка `git` считает вызовы до закрытия `withRoot`, их ноль.
  - `preview-builder.test.ts`: `withRoot` зовётся один раз (тест Э2.9 остаётся зелёным); `withRoot: async () => null` — `drift: 'unknown'`, сборка доходит до `ready`; кандидат есть и копия свежая — сравнение с головой `main`; кандидат без свежей копии — `readBranchHead` не вызван.
  - `preview-record.test.ts`: запись прежнего вида без `drift` читается, размер с `drift` и полными путями синхронизации в пределах 8 КиБ.
- *Стенды.* `pnpm gates`, `pnpm verify:release`: в S11 шаг перед `sites:sync` проверяет `drift: 'version'` в записи предпросмотра после правки `wp-includes/version.php` на хостинге; после принятия `preview_environments.seed_sync_id` не равен `sites.code_sync_id`, в записи новой сборки `none`. `project.get.drift` рождается в Э7.2 после слияния чатов, поэтому его здесь не проверяют: `undefined` тоже ложно.
- *Готово.* `preview_environments.runtime` несёт `drift` после каждой свежей копии, сборка при дрейфе доходит до `ready`.
- *Зависит.* Э2.6, Э2.9, Э6а.6 (один файл).
- *Параллельно.* С Э6а.7, Э6а.8. Если Э6а.9 уже влит, шаг S11 дописывается здесь; иначе он входит в Э6а.9.

## Э6а.11. Одна копия базы на сайт

**Э6а.11. Следующая копия базы сайта ждёт предыдущую.**
- *Цель.* Т51: не больше одной копии базы на сайт одновременно. Два диалога одного сайта не читают живую базу разом. Текст клиенту стоит в Э6а.1.
- *Файлы.*
  - `apps/core/src/previews/preview-builder.ts`: `PreviewBuildDeps`, вызов строки 637.
  - `apps/core/src/previews/previews.providers.ts`: `seedCopies: new KeyedLock()`.
  - `apps/core/src/testing/previews.ts`: то же в фикстуре.
  - `apps/core/src/previews/preview-builder.test.ts`.
- *Договор.*

  ```ts
  // PreviewBuildDeps
  /** One copy of a site's database at a time (Т51): the next one waits. */
  seedCopies: Pick<KeyedLock, 'run'>

  // buildPreviewOn, строка 637
  const stored = await deps.seedCopies.run(site.id, () => {
    signal.throwIfAborted()
    return storePreviewSeed(deps, seedRef, { … }, signal)
  })
  ```

  `KeyedLock` — `apps/core/src/git-workspace/mirror-store.ts:49`. Замок живёт в процессе: сервис `core` на app-ВМ один (`infra/app/docker-compose.yml:222`, без `replicas`). Появятся реплики — Р8. Ожидание идёт под удержанием предпросмотра: его пульс не останавливается, а отменённая сборка выходит на `throwIfAborted`.

  Запрещено: держать замок на всю сборку, отказывать второй копии вместо ожидания.
- *Тесты.* `preview-builder.test.ts`: `a second copy of a site waits for the first; another site does not`. Падает до правки: копии пересекаются. Рядом контроль: отменённая в очереди сборка копию не начинает.
- *Стенды.* `pnpm gates`, `pnpm verify:release`: регрессия соседних диалогов S5a, S6a.
- *Готово.* Две сборки свежей копии одного сайта читают базу по очереди.
- *Зависит.* Ничего.
- *Параллельно.* Со всем, кроме Э6а.6 и Э6а.10: один файл.

## Э6а.12. `code_sync` на новых стеках

**Э6а.12. Сценарий R8: тупик `conflict` снимается на Joomla, OpenCart и MODX.**
- *Цель.* М4б и строка З7 на каждом новом стеке. S11 доказывает это только на WordPress, а сценарий R6 оставляет сайт в тупике. Срез снимает круг: Э3 отсылал `code_sync` к Э6а, Э6а — к Э3.
- *Файлы.*
  - `infra/dev/stack-verify/scenarios-release.mjs` — сценарий R8.
  - `infra/dev/stack-verify/stand.mjs` — `operatorEnvironment`, запуск `sites:sync` из приватной копии дерева, как у `verify:release` (`setup.mjs:461`).
  - `infra/dev/stack-verify/stand.test.mjs`, `README.md`.
- *Договор.* R8 идёт в группе `release` сразу после R6 на той же сборке и подхватывает её сайт: кандидат есть, файл стиля на хостинге изменён, `main` стоит на прежнем. Поля `StackStand` новых не требует: `edit(build).style`, `shownAt`, `page`.

  | Шаг | Что проверяется |
  | --- | --- |
  | R8a | `sites:sync start`, `ready`: `modified` содержит файл стиля из `edit(build)`; картинка, добавленная на хостинге под корнем `mediaRoots`, есть только в `media`. Удалённый `main` прежний |
  | R8b | `accept`: `pushed`; голова `main` — `commit_sha`, один родитель, трейлер `Raditi-Sync`; нового тега нет, новых заданий нет; `installed_sha` равен коммиту, `installed_version` и `installed_release_id` прежние; файлы хостинга не менялись; кандидат диалога `stale` |
  | R8c | «Обновить», затем `/release`: `installed`, правка хостинга на месте, номер следующий, а не сгоревший. Тупик снят |
  | R8d | «Отменить выпуск» этого выпуска показывает `returnsTo`, равный версии до `code_sync` |
  | R8e | `release.undoPlan` выпуска до `code_sync` кончается `undo_outdated` |

  Правило А11 на новых стеках доказывать не нужно: код `compareWithMain` общий, его держат `code-sync.test.ts` и C1–C4. Сценарий проверяет шов: рабочий набор стека, `mediaRoots`, запись `readStack` при принятии.

  R8 не называет стеков: условие только по полям. У стека, где поля стиля нет, стенд не собирается, а не пропускает сценарий.

  Запрещено: правка файлов `release-verify`; условие по имени стека; подмена шага `sites:sync` записью в базу.
- *Тесты.* `stand.test.mjs`: R8 идёт в `release` после R6 у каждой записи `STACK_STANDS`, у Joomla, OpenCart и MODX. Падает до правки: сценария нет.
- *Стенды.* `pnpm gates`; `pnpm verify:stack -- --group=release`; job `stand` на PR.
- *Готово.* На каждой сборке каждого стека, который уже в `STACK_STANDS`, выпуск, заведённый в `conflict` правкой на хостинге, проходит после `sites:sync`. Стек, пришедший позже, получает R8 сам: сценарий общий.
- *Зависит.* Э6а.9, Э3.12.
- *Параллельно.* С Э4.7 и Э5.8: общий `scenarios-release.mjs`, разные сценарии. Не вместе с Э3.13, который меняет `verify-stack.mjs`.

## Расхождения с проектом

**Р1. Слова «версия с обновлённой копией» не входят в Э6а.** Т50 требует их у `undoReturnsTo`. Но поле ленты — `versionTagSchema` (`packages/domain/src/tasks/client-feed.ts:620,903`), а тексты — `client-feed-labels.ts:621` и `chat-texts.ts:235`, оба меняет ветка чатов, и §5.3 ставит такие правки после слияния. Сделано: Э6а отдаёт верный номер, Э6б.2 добавляет к ленте и окну признак `afterSync` и слова. Как назвать такую версию — вопрос Он4.

**Р2. `main_before_sha NOT NULL` при создании строки.** Строку создаёт `packages/db`, без git; голову `main` читает только `core`. Голову нельзя заменить на `installed_sha` навсегда: после отката выпуска `main` стоит на revert-коммите (`release-skill.ts:1875`), а `installed_sha` на прежнем. Предложение: схема как в проекте, строка рождается с `installed_sha`, сравнение на шаге 3 пишет настоящую голову.

**Р3. `requested_by` и `confirmed_by` здесь необязательные.** Проект пишет `requestedBy String`. Образец `ReleaseUndoPlan.requestedBy` — `String?` с `onDelete: SetNull` (`schema.prisma:2420,2443`), иначе удаление пользователя упрётся в строку истории. Предложение: как у образца.

**Р4. Порог Т49 ломает WordPress.** Импорт сегодня берёт медиа до 1 ГиБ вместе с кодом, настоящий сайт на 416 МБ прошёл (`limits.ts:42-48`, ответ владельца от 25.10.2026). Т49 без оговорки отказал бы WordPress с медиатекой больше 256 МиБ, а бриф §6 запрещает регрессию. WordPress при этом обязан объявить `mediaRoots`: без них `code_sync` скачивал бы медиатеку. Предложение: поле `capped`, у WordPress `false` (вопрос В2). С Э12 поле остаётся: `capped: true` значит «сверх порога медиа остаётся на хостинге», а `capped: false` у WordPress значит, что его медиа и после Э12 идут в git (Э12.1).

**Р5. «Пуш без `--force`».** `pushTrustedCommit` идёт через `--force-with-lease=<ref>:<expected>` (`git-workspace.service.ts:843`). Родитель равен `expected`, поэтому это fast-forward, а lease только строже. Предложение: брать существующий путь, как выпуск.

**Р6. «Коммит собирается в зеркале».** Комментарий `trustedCommit` (строка 794) говорит, что объекты остаются в зеркале, но `commit-tree` пишет в приватный репозиторий операции, и `dispose` его удаляет: выпуск просто собирает тот же SHA заново. С файлами хостинга так нельзя, их уже нет. Предложение: `hostingCommit` пишет явно через `GIT_OBJECT_DIRECTORY`, комментарий правится.

**Р7. «Удаляет неподтверждённый коммит».** Такой операции в коде нет: `gc.auto=0`, `--no-auto-maintenance`. Предложение: `dropUnreachable` (`git prune --expire=now`) под замком зеркала и `commit_sha = NULL` как отметка. Запас: `prune` не идёт, пока у сайта есть активная строка.

**Р8. Т51 не назначена этапу в §5.1, замок в процессе.** В постановке этапа Т51 есть, в таблице §5.1 нет, поэтому срез Э6а.11. Таблицы или колонки для этого в §2.6 нет, а `pg` у `core` нет, поэтому замок в памяти. Пока `core` один, этого хватает. С репликами (M10) нужен замок в PostgreSQL. Проверка MyISAM под записью требует OpenCart: её надо вписать в договор Э4.

**Р9. Барьер не «одним условным UPDATE».** Строка `site_leases` появляется при первом `acquire` (`site-leases.ts:94`). У сайта без единого хода её нет, и UPDATE не нашёл бы строку, а тупик `conflict` возможен и там. Предложение: `INSERT … ON CONFLICT DO UPDATE … WHERE`, свободная строка проходит `site_leases_state_check`. Значение истёкшей аренды проект тоже не называл: `deploy` и `revert` считаются держателями и после срока, иначе выпуск, забравший истёкшую аренду (`takeOverReleaseLease`), разминулся бы с барьером.

**Р10. Стенд М4б.** §5.5 ставит его в `verify:stack`, а §5.1 разрешает вести Э6а параллельно Э3, где этот стенд рождается. Рубежу нужно доказательство и на WordPress. Сделано: S11 в `verify:release` и C1–C4 в `verify:site-import`; в `verify:stack` те же шаги приносит Э6а.12, сценарий R8.

**Р11. Паспорта в Э6а нет.** Т17 пишет итог «отличием `code_drift` в паспорте», но схему `previewPassportSchema` вводит Э0д, а отличия записывает Э7.2. Предложение: `PreviewRecord.drift`, как уже договорено в `62-slices/after.md`. Значение `unknown` есть в записи (`gap-one-shot` §5.3) и нет в типе §2.3: Э7 читает его как `none`.

**Р12. Пустая папка расширения.** Git не хранит пустых папок. Папка без файлов в `extensionRoots` на хостинге даёт `folders` и после `code_sync`. Вреда мало: `folders` выпуск не останавливает, но предупреждение не снимется. Предложение: принять в первой волне, снять, когда клиент это увидит.

**Р13. Запуск `ready` и уникальный индекс.** Индекс одной активной строки не пустил бы новое сравнение до конца суток. Т50: новая постановка переводит строку `ready`, которую не приняли, в `cancelled`, код `superseded`. Дойти до этого может строка старше часа или устаревшая (Р16): остальных не пускает предел в час.

**Р14. `mediaRoots` OpenCart.** Т54 называет `image/catalog/` как границу менеджера файлов. Для медиа этого мало: `image/payment/` и `image/placeholder.png` — тоже картинки. Значение: корень `image/`, исключение `image/cache/`, общий список `mediaFileExtensions`, `capped: true`. Договор Э4, «Передаётся дальше», приведён к нему. Отдельного списка расширений у OpenCart нет.

**Р15. При принятии пишется вся часть `readStack`, а не только версия.** Т50 говорит «версия в записи сайта», а Т13 — что `code_sync` пишет запись. После обновления мог смениться и `adminPath`, и `extras`. Э2.8 уже даёт одну часть на всё и запрещает писать мимо `mergeSiteStackFacts`. Предложение: `summary.facts` хранит часть, принятие её пишет; при отказе раскладки сравнение кончается `layout_unsupported`, а клиент узнаёт это до коммита.

**Р16. Как узнать устаревшую сводку.** Т50 и правка 17 говорят, что она повторяется вне часового предела, а доска показывает вид «Сводка устарела», но условия никто не называет. Значение по умолчанию, вопрос В7: `ready`, если после начала сравнения установилась версия (`sites.installed_at > created_at`), или `failed` с `main_moved` и `commit_lost`. Сравнивать `main_before_sha` с `installed_sha` нельзя: после отката они законно расходятся (Р2). Выпуск, который откатился, `installed_at` не двигает: его сводка устаревает при принятии, пуш отвечает `moved`, новой версии на сайте нет. Поэтому слова о причине нейтральны и верны в обоих случаях (по умолчанию, Т50): «Сводка устарела: сайт менялся после этого сравнения. Сравните файлы ещё раз.» Доска `O-sync-summary` пока идёт прежними словами.

**Р17. Этап подсчёта на экране настройки.** Договор говорил, что `SetupSteps` не меняется, а Т51 дописывается к заметке. Доска `O-setup-running` рисует четыре этапа, свою заметку на шаге `list` и строку Т51 отдельным абзацем только на этапе копирования. Правится по доске: `site-setup.tsx` и `setup-text.ts` ветка чатов не меняет, поэтому ждать слияния не нужно. Заметка «Смотрим, войдёт ли сайт в копию целиком.» и поле `load` — новые, текст ждёт вычитки вместе с остальными (вопрос Он1).

**Р18. Предел суток и смена доступа.** Договор отказывал при трёх упавших, а доска и Т50 говорили о повторах, и клиент, который сменил пароль после трёх `auth_failed`, ждал бы конца суток в тупике `conflict`. Значение по умолчанию (Т50): число одно, «сравнить можно 3 раза в сутки», это попытки; упавшие считаются только с момента последней смены доступа к файлам. Момент уже есть в базе, `site_code_sources.updated_at`: новой колонки нет, запрос и довод в Э6а.7. Доска `O-sync-failed` пока говорит «Повторить сравнение можно 3 раза в сутки.» и «Повторов больше нет»: верны слова Э6б.2.

**Р19. Пустая сводка при выпавших файлах.** Изменённый файл с находкой или файл, который не прочитался, идёт в `left_out`, сравнение кончается `no_changes`, а клиент читал бы «Файлы кода на сайте не изменились», хотя мы этого не знаем. Значение по умолчанию (Т50, Э6а.7): первая фраза об остальных файлах, вторая называет число `leftOut`. Случая нет на доске `O-sync-summary`, текст ждёт вычитки вместе с Он1.

## Вопросы

| № | Вопрос | Рекомендация | Что зависит |
| --- | --- | --- | --- |
| В1 | Текст отказа `media_too_large`: в проекте его нет, на доске другие слова (вопрос Он27) | «На сайте слишком много картинок и документов: мы копируем до 10 000 таких файлов и до 256 МБ. Такие сайты мы пока не подключаем.» | Э6а.2 |
| В2 | Действует ли порог Т49 на WordPress до Э12 (Р4) | Нет: `capped: false`, сайт, который подключается сегодня, не перестаёт подключаться | Э6а.2. Вопрос 15 проекта об этом молчит |
| В3 | Что считать медиа | Новые стеки: список `mediaFileExtensions`, остальное под корнем — код, сравнение его читает и показывает. WordPress: всё под `wp-content/uploads/`, кроме `phpCodeNameParts`: плагины пишут туда что угодно, список не бывает полным | Сводка `code_sync` |
| В4 | Текст при нулевой разнице. Снят доской `O-sync-summary`, правка 17: «Файлы кода на сайте не изменились, обновлять копию не нужно.» Осталось значение для случая, которого на доске нет: файлы кода те же, загруженные файлы другие | Первая фраза доски, затем прежние слова о загруженных файлах. Строки об отмене нет | Э6а.7, Э6б.2 |
| В5 | До Э6б правило 3 говорит «запускает и подтверждает клиент», а вход — команда оператора | Оператор действует по просьбе клиента, `--by` называет его, аудит хранит обоих. На настоящих клиентов это не повлияет: их нет до M10 | Э6а.9 |
| В6 | Папка, которая на хостинге вдруг пуста, а в `main` с файлами: сервер мог ответить пустым списком без ошибки | Особого правила нет: файлы идут в `deleted`, клиент видит их в сводке. Отказ заводил бы в тупик сайт, где папку и правда очистили | Э6а.7 |
| В7 | Что считать устаревшей сводкой (Р16) | `ready` при `sites.installed_at > created_at`; `failed` с `main_moved` и `commit_lost` | Э6а.7, Э6б.1, вид «Сводка устарела» |
