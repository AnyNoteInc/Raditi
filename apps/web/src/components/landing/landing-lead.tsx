'use client'

import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import {
  leadFieldIssues,
  leadInputSchema,
  leadLimits,
  type LeadField,
} from '@repo/domain/leads/lead-input'
import { captchaErrorMessage, useSmartCaptcha } from '@repo/ui/captcha'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

import { legalDocumentHref } from '@/lib/legal'
import { nbsp } from '@/lib/nbsp'

import { LandingIcon } from './landing-icons'
import styles from './lead.module.css'

/** The header the server reads the SmartCaptcha token from (CAPTCHA_HEADER of @repo/auth). */
const CAPTCHA_HEADER = 'x-captcha-response'

type Values = Record<Exclude<LeadField, 'consent'>, string> & { consent: boolean; check: string }

const empty: Values = {
  name: '',
  phone: '',
  email: '',
  site: '',
  about: '',
  consent: false,
  check: '',
}

const fields = [
  { key: 'name', label: 'Имя', type: 'text', autoComplete: 'name', placeholder: 'Анна' },
  {
    key: 'phone',
    label: 'Телефон',
    type: 'tel',
    autoComplete: 'tel',
    inputMode: 'tel',
    placeholder: '+7 900 000-00-00',
  },
  {
    key: 'email',
    label: 'Электронная почта',
    type: 'email',
    autoComplete: 'email',
    placeholder: 'anna@example.ru',
  },
  {
    key: 'site',
    label: 'Адрес сайта',
    type: 'text',
    autoComplete: 'url',
    inputMode: 'url',
    placeholder: 'kofeinya.ru',
  },
] as const

type Sent = { name: string; site: string }

/** What the server said, read without trusting its shape. */
function serverAnswer(body: unknown): {
  message?: string
  fields?: Partial<Record<LeadField, string>>
} {
  if (typeof body !== 'object' || body === null) return {}
  const { message, fields: issues } = body as { message?: unknown; fields?: unknown }
  return {
    message: typeof message === 'string' ? message : undefined,
    fields:
      typeof issues === 'object' && issues !== null
        ? (issues as Partial<Record<LeadField, string>>)
        : undefined,
  }
}

/**
 * «50 кредитов в подарок»: a lead to connect a site, free of charge (docs/plan/65-landing-platforms-leads.md,
 * Л3). The fields are checked here with the schema the server uses; the lead goes to
 * POST /api/leads with the SmartCaptcha token, and the server writes it before anything leaves for
 * Telegram. The gift is the one of the sign-up (Л4): the lead credits nothing by itself.
 */
export function LandingLead({
  captchaSiteKey,
  isGuest,
}: {
  captchaSiteKey?: string
  isGuest: boolean
}) {
  const id = useId()
  const captcha = useSmartCaptcha(captchaSiteKey, { theme: 'light' })
  const [values, setValues] = useState<Values>(empty)
  const [errors, setErrors] = useState<Partial<Record<LeadField, string>>>({})
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (sent) doneRef.current?.focus()
  }, [sent])

  const check = (next: Values) => {
    const parsed = leadInputSchema.safeParse(next)
    return parsed.success ? {} : leadFieldIssues(parsed.error)
  }

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    const next = { ...values, [key]: value }
    setValues(next)
    // After the first try a field says at once when it is right again.
    if (tried) setErrors(check(next))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setTried(true)
    setFailure(null)
    const issues = check(values)
    setErrors(issues)
    const first = Object.keys(issues)[0]
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus()
      return
    }
    setBusy(true)
    try {
      let token: string | null
      try {
        token = await captcha.execute()
      } catch (error) {
        const message = captchaErrorMessage(error)
        if (message) setFailure(message)
        return
      }
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { [CAPTCHA_HEADER]: token } : {}),
        },
        body: JSON.stringify(values),
      })
      const answer = serverAnswer(await response.json().catch(() => null))
      if (!response.ok) {
        if (answer.fields) setErrors(answer.fields)
        setFailure(answer.message ?? 'Не удалось отправить заявку. Попробуйте ещё раз.')
        return
      }
      setSent({ name: values.name.trim().split(/\s+/)[0] ?? '', site: values.site.trim() })
      setValues(empty)
      setTried(false)
      setErrors({})
    } catch {
      setFailure('Не удалось отправить заявку: нет связи. Проверьте интернет и попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  const fieldId = (key: string) => `${id}-${key}`
  const errorId = (key: string) => `${id}-${key}-error`
  const described = (key: LeadField) => (errors[key] ? errorId(key) : undefined)

  return (
    <section id="lead" className={styles.lead} aria-labelledby="lead-title">
      <div className={styles.inner}>
        <div className={styles.offer} data-reveal>
          <span className={styles.free}>
            <i aria-hidden="true" />
            {nbsp('Подключение и настройка — бесплатно')}
          </span>
          <div className={styles.gift} aria-hidden="true">
            <span>{isGuest ? signupGiftCredits : '0\u00a0₽'}</span>
            <svg viewBox="0 0 60 60" focusable="false">
              <circle cx="30" cy="30" r="30" />
              <path d="M30 17.5v25M19.175 23.75l21.65 12.5M19.175 36.25l21.65-12.5" />
            </svg>
          </div>
          {/* The gift is the one of the sign-up (Л4): a signed-in visitor has had it, so the
              section offers them the free connection only. */}
          {isGuest ? (
            <h2 id="lead-title">
              <span className={styles.giftWords}>{signupGiftCredits} </span>
              кредитов в&nbsp;подарок
              <br />
              за&nbsp;заявку.
            </h2>
          ) : (
            <h2 id="lead-title">
              <span className={styles.giftWords}>0&nbsp;₽ </span>
              за&nbsp;подключение
              <br />
              и&nbsp;настройку.
            </h2>
          )}
          <p className={styles.lede}>
            {nbsp(
              isGuest
                ? `Оставьте заявку — мы сами подключим ваш сайт, настроим Радити под вашу систему, а ${signupGiftCredits} кредитов на первые задачи придут вместе с регистрацией.`
                : 'Оставьте заявку — мы сами подключим ваш сайт и настроим Радити под вашу систему.',
            )}
          </p>
          <ol className={styles.steps} role="list">
            <li>
              <span>01</span>
              <strong>Заявка</strong>
              <p>{nbsp('Две минуты, без договоров')}</p>
            </li>
            <li>
              <span>02</span>
              <strong>Подключим</strong>
              <p>{nbsp('Свяжемся и всё сделаем сами')}</p>
            </li>
            <li>
              <span>03</span>
              <strong>Пишите в&nbsp;чат</strong>
              <p>
                {nbsp(
                  isGuest
                    ? `${signupGiftCredits} кредитов — на первые задачи`
                    : 'Обычными словами, как коллеге',
                )}
              </p>
            </li>
          </ol>
        </div>

        <div className={styles.card}>
          {sent ? (
            <div className={styles.done} role="status">
              <svg
                className={styles.doneSign}
                viewBox="0 0 60 60"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="30" cy="30" r="30" />
                <path d="M30 17.5v25M19.175 23.75l21.65 12.5M19.175 36.25l21.65-12.5" />
              </svg>
              <h3 ref={doneRef} tabIndex={-1}>
                Заявка у&nbsp;нас{sent.name ? `, ${sent.name}` : ''}.
              </h3>
              <p>
                {nbsp(
                  isGuest
                    ? `Свяжемся с вами и подключим ${sent.site}. Подключение и настройка — бесплатно, а ${signupGiftCredits} кредитов придут, как только вы зарегистрируетесь.`
                    : `Свяжемся с вами и подключим ${sent.site}. Подключение и настройка — бесплатно.`,
                )}
              </p>
              <button type="button" className={styles.again} onClick={() => setSent(null)}>
                Отправить ещё одну
              </button>
            </div>
          ) : (
            <form
              ref={formRef}
              className={styles.form}
              onSubmit={submit}
              noValidate
              aria-labelledby={`${id}-title`}
            >
              <div className={styles.formHead}>
                <h3 id={`${id}-title`}>Заявка на&nbsp;подключение</h3>
                <span>Все поля обязательны</span>
              </div>
              <div className={styles.pair}>
                {fields.map((field) => (
                  <div key={field.key} className={styles.field}>
                    <label htmlFor={fieldId(field.key)}>{field.label}</label>
                    <input
                      id={fieldId(field.key)}
                      name={field.key}
                      type={field.type}
                      autoComplete={field.autoComplete}
                      inputMode={'inputMode' in field ? field.inputMode : undefined}
                      placeholder={field.placeholder}
                      value={values[field.key]}
                      onChange={(event) => set(field.key, event.target.value)}
                      aria-invalid={errors[field.key] ? true : undefined}
                      aria-describedby={described(field.key)}
                      required
                    />
                    {errors[field.key] && (
                      <span id={errorId(field.key)} className={styles.error}>
                        {errors[field.key]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className={styles.field}>
                <label htmlFor={fieldId('about')}>Что хотите менять на&nbsp;сайте</label>
                <textarea
                  id={fieldId('about')}
                  name="about"
                  rows={4}
                  maxLength={leadLimits.aboutMaxChars}
                  placeholder="Например: обновлять цены в меню и публиковать новости о мероприятиях"
                  value={values.about}
                  onChange={(event) => set('about', event.target.value)}
                  aria-invalid={errors.about ? true : undefined}
                  aria-describedby={described('about')}
                  required
                />
                {errors.about && (
                  <span id={errorId('about')} className={styles.error}>
                    {errors.about}
                  </span>
                )}
              </div>
              {/* The trap: hidden from people and from the keyboard, filled only by robots. Its name
                  and label are like no field a browser fills in by itself. */}
              <div className={styles.trap} aria-hidden="true">
                <label htmlFor={fieldId('check')}>Оставьте это поле пустым</label>
                <input
                  id={fieldId('check')}
                  name="raditi_check"
                  tabIndex={-1}
                  autoComplete="off"
                  data-1p-ignore=""
                  data-lpignore="true"
                  value={values.check}
                  onChange={(event) => set('check', event.target.value)}
                />
              </div>
              <div className={styles.consent}>
                <input
                  id={fieldId('consent')}
                  name="consent"
                  type="checkbox"
                  checked={values.consent}
                  onChange={(event) => set('consent', event.target.checked)}
                  aria-invalid={errors.consent ? true : undefined}
                  aria-describedby={described('consent')}
                  required
                />
                <label htmlFor={fieldId('consent')}>
                  Согласен(на) на{' '}
                  <a href={legalDocumentHref('consent')} target="_blank" rel="noreferrer">
                    обработку персональных данных
                  </a>
                </label>
                {errors.consent && (
                  <span id={errorId('consent')} className={styles.error}>
                    {errors.consent}
                  </span>
                )}
              </div>
              {failure && (
                <p className={styles.failure} role="alert">
                  {failure}
                </p>
              )}
              <button type="submit" className={styles.send} disabled={busy} aria-busy={busy}>
                {busy ? 'Отправляем…' : 'Отправить заявку'}
                <LandingIcon
                  name="arrow-up-right"
                  size={22}
                  strokeWidth={1.8}
                  linecap="round"
                  linejoin="round"
                />
              </button>
              {captcha.widget}
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
