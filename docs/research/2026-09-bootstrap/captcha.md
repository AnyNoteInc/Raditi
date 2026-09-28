# Yandex SmartCaptcha для better-auth 1.7: итоги исследования

**Коротко.** В better-auth 1.7.6 (сейчас `latest`) Yandex SmartCaptcha встроенно не поддерживается. Лучший путь — свой небольшой плагин на `hooks.before` и `createAuthMiddleware`. Заголовок тот же, что у встроенного плагина: `x-captcha-response`. На клиенте — `InvisibleSmartCaptcha` из `@yandex/smart-captcha@2.9.1`, он работает с React 19. Попутно нашёл в AnyNote четыре проблемы с капчей, при переносе их не повторяем (раздел 6).

## 1. Есть ли в better-auth 1.7 поддержка Yandex SmartCaptcha

**Нет.** Проверил по исходникам пакета `better-auth@1.7.6` из npm, файл `dist/plugins/captcha/constants.mjs`. Поддерживаются только эти провайдеры:

- `cloudflare-turnstile`
- `google-recaptcha`
- `hcaptcha`
- `captchafox`
- `vercel-botid`

Документация говорит то же: https://www.better-auth.com/docs/plugins/captcha

- **PR на поддержку Яндекса открыт, но не принят.** Это [better-auth#9136](https://github.com/better-auth/better-auth/pull/9136) «feat(captcha): add support for Yandex SmartCaptcha». Открыт 2026-04-12, последняя активность 2026-07-04, направлен в ветку `next`. Когда его выпустят, неизвестно. В нём используется старый адрес `smartcaptcha.yandexcloud.net`.
- **Подменить адрес проверки через `siteVerifyURLOverride` не получится.** Встроенные обработчики отправляют поля `response` и `remoteip` и ждут в ответе `data.success`. Яндекс принимает `token` и `ip` и отвечает полем `status: "ok"`.
- **Встроенный плагин проверяет только HTTP-запросы.** Он работает через `onRequest`, а тот вызывается только в HTTP-роутере (`dist/api/index.mjs`). Лимит частоты запросов тоже стоит только там. Вызовы `auth.api.*` из tRPC или server actions идут мимо капчи и мимо лимита.
- **`hooks.before` срабатывает на обоих путях: и на HTTP, и на `auth.api.*`.** В `dist/api/dispatch.mjs` в контекст хука попадают `path: endpoint.path`, `headers` и `request`. Поэтому свой плагин лучше строить на `hooks.before`.
- **Заголовок — `x-captcha-response`**, как у встроенного плагина. Если PR #9136 примут, перейти на него будет просто.

### Набросок серверного плагина

Файл `packages/auth/src/smart-captcha.ts`. Все импорты — из публичных путей `better-auth` и `better-auth/api`, это я проверил по `exports` пакета 1.7.6.

```ts
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getIP } from 'better-auth/api'
import { z } from 'zod'

export const CAPTCHA_HEADER = 'x-captcha-response'
const VALIDATE_URL = 'https://smartcaptcha.cloud.yandex.ru/validate'

// Endpoints that create accounts, check passwords or send e-mail.
export const DEFAULT_CAPTCHA_PATHS = [
  '/sign-up/email',
  '/sign-in/email',
  '/request-password-reset',
  '/send-verification-email',
  // add '/sign-in/magic-link', '/email-otp/send-verification-otp' if those plugins are enabled
] as const

const ERROR_CODES = {
  CAPTCHA_REQUIRED: { code: 'CAPTCHA_REQUIRED', message: 'Подтвердите, что вы не робот' },
  CAPTCHA_FAILED: { code: 'CAPTCHA_FAILED', message: 'Проверка не пройдена, попробуйте ещё раз' },
} as const

const validateResponseSchema = z.object({
  status: z.enum(['ok', 'failed']),
  message: z.string().optional(),
  host: z.string().optional(),
})

export type CaptchaVerdict =
  | { kind: 'pass'; host?: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'unavailable'; reason: string }

export async function validateSmartCaptcha(input: {
  serverKey: string
  token: string
  ip?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<CaptchaVerdict> {
  const { serverKey, token, ip, timeoutMs = 3000, fetchImpl = fetch } = input
  let res: Response
  try {
    res = await fetchImpl(VALIDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: serverKey, token, ...(ip ? { ip } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.name : 'network' }
  }
  // Only transport-level trouble counts as "unavailable"; 4xx (e.g. 403 = bad server key) fails closed.
  if (res.status >= 500 || res.status === 429) return { kind: 'unavailable', reason: `http_${res.status}` }
  if (!res.ok) return { kind: 'fail', reason: `http_${res.status}` }
  const parsed = validateResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) return { kind: 'fail', reason: 'bad_body' }
  return parsed.data.status === 'ok'
    ? { kind: 'pass', host: parsed.data.host }
    : { kind: 'fail', reason: 'failed' }
}

export type SmartCaptchaOptions = {
  serverKey: string
  paths?: readonly string[]
  /** Pass on network errors, timeouts and 5xx, as Yandex recommends. Default: true. */
  failOpen?: boolean
  /** Only needed when "Отключить проверку домена" is on for this captcha. */
  allowedHosts?: readonly string[]
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Metrics hook (prom-client counter). */
  onVerdict?: (verdict: CaptchaVerdict & { path: string }) => void
}

export const smartCaptcha = (options: SmartCaptchaOptions) => {
  const paths = new Set<string>(options.paths ?? DEFAULT_CAPTCHA_PATHS)
  return {
    id: 'smart-captcha',
    $ERROR_CODES: ERROR_CODES,
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path !== undefined && paths.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            // auth.api.* called by our own server code with no client request (seed, admin tools).
            if (!ctx.request && !ctx.headers) return
            const token = ctx.headers?.get(CAPTCHA_HEADER)?.trim()
            if (!token) throw APIError.from('BAD_REQUEST', ERROR_CODES.CAPTCHA_REQUIRED)

            const source = ctx.request ?? ctx.headers
            const ip = source ? (getIP(source, ctx.context.options) ?? undefined) : undefined
            const verdict = await validateSmartCaptcha({ ...options, token, ip })
            options.onVerdict?.({ ...verdict, path: ctx.path })

            if (verdict.kind === 'unavailable') {
              ctx.context.logger.warn('SmartCaptcha unavailable', { reason: verdict.reason, path: ctx.path })
              if (options.failOpen ?? true) return
              throw APIError.from('SERVICE_UNAVAILABLE', ERROR_CODES.CAPTCHA_FAILED)
            }
            if (verdict.kind === 'fail') {
              if (verdict.reason.startsWith('http_4')) {
                ctx.context.logger.error('SmartCaptcha rejected the server key', { reason: verdict.reason })
              }
              throw APIError.from('FORBIDDEN', ERROR_CODES.CAPTCHA_FAILED)
            }
            // Empty host = "cloud blocked or internal failure" per docs -> treated as trusted.
            if (options.allowedHosts?.length && verdict.host && !options.allowedHosts.includes(verdict.host)) {
              throw APIError.from('FORBIDDEN', ERROR_CODES.CAPTCHA_FAILED)
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
```

**Подключение в `betterAuth({...})`:**

- **Капча — первым плагином в `plugins`.** Хуки `before` выполняются в порядке плагинов.
- **Реальный адрес клиента.** Сервер за обратным прокси, поэтому нужно указать `advanced.ipAddress.ipAddressHeaders` и `trustedProxies`. `trustedProxies` появился в 1.7 (есть в `init-options.d.mts`). Без этого в Яндекс и в лимит частоты уйдёт адрес прокси.
- **Лимит частоты запросов.** Встроенный лимит срабатывает раньше плагинов (PR [#10191](https://github.com/better-auth/better-auth/pull/10191)). Если реплик несколько, а Redis убираем, храним счётчики в базе: `rateLimit.storage: 'database'`. Точную схему правил в 1.7 проверю, когда буду это реализовывать.

### Клиент

Токен передаётся в `fetchOptions.headers`, как в документации better-auth:

```ts
const token = await execute()                       // null when captcha is disabled
const { error } = await authClient.signIn.email({
  email, password,
  fetchOptions: { headers: token ? { 'x-captcha-response': token } : {} },
})
// same for authClient.signUp.email(...) and authClient.requestPasswordReset(...)
```

## 2. Как работает Yandex SmartCaptcha

### Проверка токена на сервере

Источник: https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation

- **Запрос:** `POST https://smartcaptcha.cloud.yandex.ru/validate`, тело в `application/x-www-form-urlencoded`: `secret=<ключ_сервера>&token=<токен>&ip=<IP>`. Параметр `ip` необязателен, но Яндекс просит его передавать. Старый домен `smartcaptcha.yandexcloud.net` тоже отвечает, но в документации теперь новый.
- **Ответы:**
  - человек: `{"status":"ok","message":"","host":"example.com"}`;
  - робот: `{"status":"failed","message":""}`;
  - ошибка в запросе: `{"status":"failed","message":"Invalid or expired Token."}`.
  - Поле `message` предназначено только для диагностики, сравнивать его в коде нельзя.
- **Токен** живёт 5 минут и проверяется только один раз. Повторная проверка вернёт `failed`.
- **Что делать при сбоях.** Яндекс советует считать любой ответ с кодом не 200 успешным, то есть пропускать пользователя.
  - Но я проверил сам: при неверном или пустом серверном ключе сервис отвечает HTTP 403 и `{"status":"failed","message":"Authentication failed. Invalid secret."}`. Если буквально следовать совету, капча молча отключится при неправильной настройке.
  - **Рекомендую:** пропускать только при сетевой ошибке, таймауте, 5xx и 429. На 4xx и `status: failed` — отказывать и писать ошибку в лог.
  - Таймаут — 3 с через `AbortSignal.timeout`. Для сравнения: встроенный плагin better-auth ждёт 10 с и при сбое отказывает.
- **Ограниченный режим.** Если платёжный аккаунт Yandex Cloud не в статусе ACTIVE или TRIAL_ACTIVE, сервис отвечает `ok` на любой запрос. Капча фактически выключается, поэтому за статусом биллинга надо следить ([restricted-mode](https://yandex.cloud/ru/docs/smartcaptcha/concepts/restricted-mode)).
- **Проверка домена.** По умолчанию Яндекс сам проверяет, что капча стоит на одном из доменов из её настроек. Проверять `host` у себя нужно, только если эта проверка отключена ([domain-validation](https://yandex.cloud/ru/docs/smartcaptcha/concepts/domain-validation)).
- **Ключи.** Клиентский начинается с `ysc1_`, серверный — с `ysc2_`. Следующие 20 символов у пары совпадают — по ним можно проверить, что ключи от одной капчи ([keys](https://yandex.cloud/ru/docs/smartcaptcha/concepts/keys)).
- **Сеть сервера.** Чтобы сервер мог обращаться к `/validate`, нужен исходящий доступ к `84.201.151.229` и `2a0d:d6c1::1a:0:0:0:20e` ([ips](https://yandex.cloud/ru/docs/smartcaptcha/concepts/ips)).

### Виджет на клиенте: `@yandex/smart-captcha`

- **Версия:** `2.9.1`, опубликована 2026-02-26. Требует `react ^16.8 || ^17 || ^18 || ^19`, так что с React 19 и Next 16 совместим.
- **В пакете нет `'use client'`.** Его нужно обернуть в свой клиентский компонент. При серверном рендеринге он не падает: внутри есть проверка `useIsomorphicLayoutEffect`.
- **Что экспортирует:** `SmartCaptcha`, `InvisibleSmartCaptcha`, `useSmartCaptchaLoader`. Скрипт по умолчанию грузится с `https://smartcaptcha.cloud.yandex.ru/captcha.js`, адрес можно сменить через проп `host`.
- **Параметры** ([react](https://yandex.cloud/ru/docs/smartcaptcha/concepts/react)): `sitekey`, `visible`, `language` (`ru`…), `test`, `webview`, `shieldPosition`, `hideShield`, `theme`, `onSuccess`, `onChallengeVisible`, `onChallengeHidden`, `onNetworkError`, `onJavascriptError`, `onTokenExpired`.
- **Невидимый режим:** когда `visible` становится `true`, компонент сам вызывает `smartCaptcha.execute()`. Задание увидят только пользователи, которых сервис сочтёт подозрительными.
- **После успешной проверки виджет нужно сбросить**, иначе на сервер уйдёт уже использованный токен. Сбрасываем сменой `key`, как советует документация.
- **При `javascript-error` проверку засчитывать нельзя** — это прямое требование документации.
- **`executePromise`.** В типах пакета и в `captcha.js` есть `executePromise(widgetId)`, но в документации его нет, поэтому ниже я на него не опираюсь.
- **Тестовых ключей нет** — в отличие от Turnstile и reCAPTCHA, в документации «всегда проходящих» ключей я не нашёл. Проп `test: true` только заставляет всегда показывать задание, это для ручной проверки.
- **Уведомление об обработке данных показывать обязательно.** Если скрыть плашку через `hideShield`, пользователей нужно предупредить другим способом ([invisible-captcha](https://yandex.cloud/ru/docs/smartcaptcha/concepts/invisible-captcha)). Это стоит добавить в политику конфиденциальности, которую переносим из AnyNote.

### Набросок клиентского хука

По смыслу совпадает с `executePromise` из `captcha.js`: закрытие окна с заданием, сетевая ошибка или ошибка скрипта отменяют проверку.

```tsx
'use client'
import { InvisibleSmartCaptcha } from '@yandex/smart-captcha'
import { useCallback, useRef, useState, type ReactNode } from 'react'

export class CaptchaError extends Error {}
type Pending = { resolve: (token: string) => void; reject: (e: Error) => void }

export function useSmartCaptcha(siteKey: string | undefined): {
  execute: () => Promise<string | null>
  widget: ReactNode
} {
  const [visible, setVisible] = useState(false)
  const [generation, setGeneration] = useState(0)
  const pending = useRef<Pending | null>(null)

  const settle = (action: (p: Pending) => void) => {
    const p = pending.current
    pending.current = null
    setVisible(false)
    if (p) action(p)
  }

  const execute = useCallback((): Promise<string | null> => {
    if (!siteKey) return Promise.resolve(null) // captcha disabled (local dev, e2e)
    pending.current?.reject(new CaptchaError('superseded'))
    return new Promise((resolve, reject) => {
      pending.current = { resolve, reject }
      setVisible(true) // the component calls smartCaptcha.execute()
    })
  }, [siteKey])

  const widget = siteKey ? (
    <InvisibleSmartCaptcha
      key={generation} // token is single-use: fresh widget per attempt
      sitekey={siteKey}
      language="ru"
      visible={visible}
      onSuccess={(token) => { settle((p) => p.resolve(token)); setGeneration((g) => g + 1) }}
      onChallengeHidden={() => settle((p) => p.reject(new CaptchaError('cancelled')))}
      onNetworkError={() => settle((p) => p.reject(new CaptchaError('network')))}
      onJavascriptError={() => settle((p) => p.reject(new CaptchaError('script')))}
    />
  ) : null

  return { execute, widget }
}
```

### Content-Security-Policy

Официальной страницы про CSP у SmartCaptcha я не нашёл. Список ниже я вывел, прочитав сам `captcha.js`, — **перед включением проверить в режиме `Content-Security-Policy-Report-Only`**.

- `script-src https://smartcaptcha.cloud.yandex.ru` — основной скрипт и его части, которые он подгружает со своего же адреса.
- `frame-src https://smartcaptcha.cloud.yandex.ru` — iframe `checkbox`, `advanced` и `backend`.
- `style-src 'unsafe-inline'` — скрипт вставляет теги `<style>`, а nonce ставит, только если на странице задан `__webpack_nonce__`.
- `connect-src` на родительской странице, судя по коду, не нужен: сетевые запросы идут изнутри iframe.

### Данные в России и цена

- **Данные в России.** Сервис работает в Yandex Cloud. В январе 2025 он получил сертификаты соответствия 152-ФЗ, ГОСТ Р 57580 и PCI DSS ([release-notes](https://yandex.cloud/ru/docs/smartcaptcha/release-notes)). С правилом «данные клиентов только в России» совместимо. Яндексу уходят IP-адрес и поведенческие данные посетителя — это нужно отразить в политике как поручение обработки (формулировку лучше проверить с юристом).
- **Цена.** Платные — запросы к `/validate`. Первые 10 000 в месяц бесплатно, дальше 1 098 ₽ с НДС за 10 000 (до 100 тыс.) и 768,6 ₽ за 10 000 (свыше) ([pricing](https://yandex.cloud/ru/docs/smartcaptcha/pricing)). Цифры я получил через WebFetch со страницы, которая рендерится динамически, — стоит сверить в калькуляторе.

## 3. Переменные окружения

| Переменная | Значение | Где хранить |
| --- | --- | --- |
| `SMARTCAPTCHA_SERVER_KEY` | `ysc2_…`, только для сервера | В проде — OpenBao (Vault), локально — `.env` |
| `SMARTCAPTCHA_CLIENT_KEY` | `ysc1_…`, публичный | Обычный конфиг |

**Предлагаю назвать клиентский ключ без префикса `NEXT_PUBLIC_`**, хотя в задаче был `NEXT_PUBLIC_*`.

- По документации Next.js 16 такие переменные подставляются в код при сборке, причём и в клиентский, и в серверный. После сборки их уже не поменять ([environment-variables](https://nextjs.org/docs/app/guides/environment-variables)).
- Правильнее читать `process.env.SMARTCAPTCHA_CLIENT_KEY` в серверном `(auth)/layout.tsx` и передавать в клиент пропсом. Этот layout и так динамический из-за проверки сессии. Так один образ можно запускать с разными ключами.
- Если собирать отдельный образ под прод, `NEXT_PUBLIC_SMARTCAPTCHA_CLIENT_KEY` тоже подойдёт, но гибкость теряется.

Обе переменные добавить в `.env.example` и в `globalEnv` в `turbo.json`.

**Проверка при старте** (zod-схема в `packages/auth` или `apps/web`):

- Заданы оба ключа или ни одного, иначе ошибка. Если задан только серверный, каждый вход будет падать с `CAPTCHA_REQUIRED`.
- Префиксы `ysc2_` и `ysc1_`, и символы с 5-го по 25-й у пары совпадают — это ловит ключи от разных капч.
- В проде оба ключа обязательны. Условие — по отдельному флагу окружения (например, `APP_ENV=production`), а не по `NODE_ENV`: e2e гоняет прод-сборку без ключей.

**Что происходит, если ключи пустые** (локальная разработка и Playwright):

- плагин не регистрируется;
- `execute()` возвращает `null`, заголовок не отправляется;
- виджет не рисуется.

**Если нужно проверить виджет локально** — завести в Yandex Cloud отдельную капчу `raditi-dev` с доменом `localhost`. Примет ли консоль `localhost`, я не проверял. Если не примет — у dev-капчи отключить проверку домена и задать `allowedHosts`.

**Метрики.** Колбэк `onVerdict` можно подключить к счётчику prom-client, например `raditi_captcha_verdicts_total{path,kind}`. Для Grafana полезны оповещения: рост `unavailable` (Яндекс недоступен) и `fail` с `http_403` (неверный ключ).

## 4. Вход через Telegram — заметка на потом

- **У Telegram теперь есть официальный OpenID Connect.** Проверил discovery на `https://oauth.telegram.org/.well-known/openid-configuration`:
  - издатель `https://oauth.telegram.org`, адреса `/auth`, `/token`, `/.well-known/jwks.json`;
  - scopes `openid`, `profile`, `phone`; поддерживается PKCE S256;
  - `client_id` и `client_secret` выдаёт BotFather ([документация](https://core.telegram.org/bots/telegram-login)).
- **Подключить можно штатным `genericOAuth`** с `discoveryUrl`, без сторонних плагинов.
- **Главная загвоздка — в ответе Telegram нет email.** Колбэк better-auth 1.7.6 в этом случае отвечает `email_not_found` (`dist/api/routes/callback.mjs`).
  - Варианты: подставлять технический email через `mapProfileToUser` или использовать Telegram только для привязки к уже созданному аккаунту.
  - Второй вариант совпадает со spec (строка 629): «Telegram привязывается через вход в кабинет».
- **Готовые плагины сейчас не подходят:**
  - `better-auth-telegram@2.0.1` требует `better-auth >=1.6.22 <1.7.0`, то есть с 1.7.6 несовместим;
  - `@pddo/better-auth-telegram@0.3.2` и `telegram-better-auth@0.0.8` старые (2025).
- **Бонус:** в 1.7.6 уже есть готовый пресет «Войти с Яндекс ID» — `yandex()` в `better-auth/plugins/generic-oauth`.

## 5. Что осталось неясным

- Полный список доменов для CSP: официального документа нет.
- Можно ли указать `localhost` в списке доменов капчи.
- Точные цены: страница тарифов рендерится динамически.
- `executePromise` не описан в документации.
- В каком порядке приходят события `challenge-hidden` и `success`. Я опираюсь на то, что собственный `executePromise` Яндекса считает закрытие окна отменой.

## 6. Проблемы в AnyNote, которые не переносим

1. **Регистрация идёт в обход капчи и лимита частоты.** Она вызывается через tRPC: `auth.api.signUpEmail(...)` в `packages/trpc/src/routers/auth.ts`. Встроенный плагин на `onRequest` на этом пути не срабатывает, лимит тоже. Токен уходит в `/api/trpc`, но там его никто не проверяет. **Исправление:** проверка на `hooks.before` (как в наброске выше), а регистрацию вызывать напрямую через `authClient`.
2. **Токен хранится в глобальной переменной модуля.** `setPendingCaptchaToken` в `apps/web/src/lib/captcha-token-store.ts` — один токен на весь модуль, а заголовок добавляется ко всему batch-запросу tRPC. Возможны гонки, токен может достаться чужому запросу. **Исправление:** передавать токен явно через `fetchOptions`.
3. **Ключ reCAPTCHA не читается во время работы, хотя тест утверждает обратное.** `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` читается в серверном layout, но значение подставлено при сборке. Тест `vi.stubEnv(..., 'runtime-site-key')` вводит в заблуждение.
4. **Капча молча выключается без ключа.** Плагин регистрируется, только если `RECAPTCHA_SECRET_KEY` задан, и проверки для прода нет. Кроме того, `/sign-in/magic-link` отправляет письма, но капчей не защищён.

## Источники

- Исходники пакета `better-auth@1.7.6`, `@better-auth/core@1.7.6`, `better-call@1.4.0` (скачаны через `npm pack`) — https://www.npmjs.com/package/better-auth
- https://www.better-auth.com/docs/plugins/captcha
- https://www.better-auth.com/docs/concepts/plugins
- https://github.com/better-auth/better-auth/pull/9136
- https://github.com/better-auth/better-auth/pull/10191
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/domain-validation
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/keys
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/react
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/invisible-captcha
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/widget-methods
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/ips
- https://yandex.cloud/ru/docs/smartcaptcha/concepts/restricted-mode
- https://yandex.cloud/ru/docs/smartcaptcha/release-notes
- https://yandex.cloud/ru/docs/smartcaptcha/pricing
- https://www.npmjs.com/package/@yandex/smart-captcha (исходник 2.9.1 и `https://smartcaptcha.cloud.yandex.ru/captcha.js` смотрел напрямую)
- https://nextjs.org/docs/app/guides/environment-variables
- https://core.telegram.org/bots/telegram-login
- https://oauth.telegram.org/.well-known/openid-configuration
- https://www.npmjs.com/package/better-auth-telegram

Файлы в репозитории не менял.