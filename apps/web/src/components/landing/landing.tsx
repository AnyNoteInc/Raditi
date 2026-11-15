import { legalDocuments } from '@repo/domain'
import {
  giftTaskCounts,
  signupGiftCredits,
  typicalTaskCredits,
} from '@repo/domain/billing/credit-numbers'
import { AnimatedBrandSymbol } from '@repo/ui/animated-brand-symbol'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { CHARGED_FOR_DONE_WORK } from '@/lib/credit-price'
import { legalDocumentHref } from '@/lib/legal'
import { nbsp } from '@/lib/nbsp'
import type { LandingViewer } from '@/server/landing-viewer'

import { LandingHeader } from './landing-header'
import { LandingIcon } from './landing-icons'
import { LandingLead } from './landing-lead'
import { LandingMotion } from './landing-motion'
import { mainAction } from './main-action'
import { pluralCredits, typicalCreditsInWords } from './pricing-data'
import { SiteDemo } from './site-demo'
import styles from './landing.module.css'

// The arrows of the buttons and links: the size and stroke they had before the icons were gathered.
const arrow = { size: 20, strokeWidth: 1.7, linecap: 'round', linejoin: 'round' } as const

// A request is set as a message of the chat, so it needs no quotation marks. A result names what
// the chat gives back: a noun phrase, no past tense, nothing the agent of a chat cannot do today
// (web search, its browser on public sites, the files of the chat, documents and pages by a link).
const capabilities = [
  {
    name: 'Найти и сравнить',
    request: 'Найди три типографии рядом и сравни цены на 500 визиток',
    result: 'Таблица с ценами, сроками и ссылками',
  },
  {
    name: 'Письма и ответы',
    request: 'Ответь клиенту вежливо: заказ задержится на два дня',
    result: 'Готовый текст письма',
  },
  {
    name: 'Документы и таблицы',
    request: 'Собери из этих счетов таблицу расходов за октябрь',
    result: 'Таблица по вашим файлам',
  },
  {
    name: 'Тексты для соцсетей',
    request: 'Напиши пост о скидке выходного дня, коротко и тепло',
    result: 'Пост, который можно сразу публиковать',
  },
  {
    name: 'Страница по ссылке',
    request: 'Сделай страницу с прайсом и дай ссылку для клиентов',
    result: 'Страница на pages.raditi.ru',
  },
  {
    name: 'Разобраться в файле',
    request: 'Прочитай договор и выпиши сроки и штрафы',
    result: 'Короткая выжимка главного',
  },
]

// The order follows the visitor: what can I ask, does it suit me, what does it cost, what if it
// goes wrong, where the data lives. The page and the FAQPage markup of the search engines read this
// one list.
export const questions = [
  {
    question: 'Что умеет Радити?',
    answer:
      'Ищет в интернете и открывает сайты в своём браузере, читает ваши файлы, пишет письма, посты и документы, собирает таблицы и публикует страницы по ссылке. Пишите в чат обычными словами — если чего-то не хватит, Радити переспросит.',
  },
  {
    question: 'Нужно что-то устанавливать?',
    answer:
      'Нет. Радити работает в браузере и в Telegram: зарегистрируйтесь и напишите первую задачу.',
  },
  {
    // What the two commonest kinds of request cost: estimates of the credits model, so the answer
    // says «обычно»; the numbers are constants of the domain. The rule of the charge is the
    // sentence of the tariffs, word for word (Ц14).
    question: 'Сколько стоит одна задача?',
    answer: `Работу мы считаем в кредитах. Короткий ответ или небольшой текст — обычно ${typicalCreditsInWords(typicalTaskCredits.small)}, документ, таблица или страница — ${typicalCreditsInWords(typicalTaskCredits.block, false)}. Сколько это в рублях, написано в карточке каждого тарифа. ${CHARGED_FOR_DONE_WORK}`,
  },
  {
    question: 'А если результат не понравится?',
    answer:
      'Скажите, что поправить, — Радити доработает. Последнюю просьбу можно отменить в чате, и разговор вернётся к тому, что было до неё.',
  },
  {
    question: 'Где будут храниться данные?',
    answer:
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывает модель GLM провайдера Z.ai за рубежом; переданные ему копии могут храниться по условиям этого провайдера. Условия обработки данных описаны в документах сервиса.',
  },
]

// A hyphen or a slash lets the browser break the line inside a name, and so does a dash between
// the figures of a range: «15–» would end a line and «25» start the next.
const UNBREAKABLE = /(pages\.raditi\.ru|\d+–\d+)/

/** Readable text with non-breaking spaces and with the names and ranges kept in one piece. */
function readable(text: string): ReactNode {
  return nbsp(text)
    .split(UNBREAKABLE)
    .map((part, index) =>
      // The split puts the names and the ranges at the odd places.
      index % 2 === 1 ? (
        <span key={index} className={styles.nowrap}>
          {part}
        </span>
      ) : (
        part
      ),
    )
}

export function Landing({
  pricing,
  viewer,
  captchaSiteKey,
}: {
  pricing: ReactNode
  viewer: LandingViewer
  /** SMARTCAPTCHA_CLIENT_KEY for the form of a lead; none in local development and tests. */
  captchaSiteKey?: string
}) {
  const isGuest = viewer.status === 'guest'
  const action = mainAction(isGuest)
  // What stands under the main action: the terms in three short facts. The gift is the one of
  // the sign-up, so only a guest reads of it.
  const terms = [
    ...(isGuest
      ? [
          `${signupGiftCredits} ${pluralCredits(signupGiftCredits)} в подарок — около ${giftTaskCounts(signupGiftCredits).small} небольших задач`,
        ]
      : []),
    'В браузере и в Telegram',
    'Без установки',
  ]
  return (
    <div className={styles.page} id="top">
      {/* Tells the elements marked with `data-reveal` when they come into the window. */}
      <LandingMotion />
      <a href="#main-content" className={styles.skip}>
        Перейти к содержанию
      </a>
      <LandingHeader viewer={viewer} />
      <main id="main-content">
        <section className={styles.hero} aria-labelledby="hero-title">
          {/* The heading of the page says what the service is, in the words people search by;
              the slogan under it is the large line of the first screen. */}
          <h1 id="hero-title" className={styles.heroKey}>
            {readable('ИИ-помощник на каждый день для вас и вашего бизнеса')}
          </h1>
          <p className={styles.heroTitle}>
            <span>Напишите в&nbsp;чат.</span>{' '}
            <span>
              <em>Всё сделаем.</em>
            </span>
          </p>
          <p className={styles.heroLead}>
            {nbsp(
              'Найти, сравнить, написать письмо, собрать таблицу. Напишите обычными словами, что нужно, — Радити сделает.',
            )}
          </p>
          <div className={styles.heroActions}>
            <Link href={action.href} className={styles.primaryButton}>
              {action.label} <LandingIcon name="arrow-right" {...arrow} />
            </Link>
            <a href="#demo" className={styles.textLink}>
              Посмотреть пример <LandingIcon name="arrow-down" size={16} strokeWidth={1.7} />
            </a>
          </div>
          {/* The role is written out: without its markers Safari stops reading a list as one. */}
          <ul className={styles.heroTerms} role="list">
            {terms.map((term) => (
              <li key={term}>
                <LandingIcon
                  name="check"
                  size={18}
                  strokeWidth={2}
                  linecap="round"
                  linejoin="round"
                />
                {nbsp(term)}
              </li>
            ))}
          </ul>
        </section>

        <section
          id="demo"
          className={`${styles.section} ${styles.demoSection}`}
          aria-labelledby="demo-title"
        >
          <div className={`${styles.sectionHeading} ${styles.centred}`} data-reveal>
            <h2 id="demo-title">Попробуйте сами</h2>
            <p>
              {nbsp('Кофейня для примера. Выберите просьбу — и посмотрите, что сделает Радити.')}
            </p>
          </div>
          <SiteDemo />
        </section>

        <section id="possibilities" className={styles.section} aria-labelledby="can-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="can-title">Что можно поручить</h2>
            <p>
              {nbsp(
                'Дела, на которые обычно уходит полдня: ваша просьба — и что вы получите в ответ.',
              )}
            </p>
          </div>
          {/* A table of «a request, its result» without a table element: the category stays a
              heading, and every row names its two cells. CSS shows the names once, over the
              first row, as the heads of the columns; in the other rows only a screen reader
              takes them. */}
          <div className={styles.capabilities}>
            {capabilities.map((item) => (
              <article key={item.name} className={styles.capability}>
                <h3>{nbsp(item.name)}</h3>
                <span className={styles.columnLabel}>Например, вы&nbsp;пишете</span>
                <p className={styles.requestBubble}>{nbsp(item.request)}</p>
                <span className={styles.columnLabel}>Что вы&nbsp;получите</span>
                <p className={styles.capabilityResult}>{readable(item.result)}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="safety" className={styles.safety} aria-labelledby="safety-title">
          <div className={styles.safetyInner}>
            <div className={styles.sectionHeading} data-reveal>
              <h2 id="safety-title">Вы&nbsp;видите, что делает Радити</h2>
              <p>{nbsp('Каждый шаг — в чате. Остановить работу можно в любой момент.')}</p>
            </div>
            <ol className={styles.safetyList} role="list">
              <li>
                <span aria-hidden="true">01</span>
                <h3>Ход работы на&nbsp;виду</h3>
                <p>
                  {nbsp(
                    'Пока Радити работает, в чате видно, что он ищет, читает и пишет. Браузер помощника можно открыть и посмотреть.',
                  )}
                </p>
              </li>
              <li>
                <span aria-hidden="true">02</span>
                <h3>Остановить и&nbsp;вернуть</h3>
                <p>
                  {nbsp(
                    'Работу можно остановить, а последнюю просьбу — отменить: разговор вернётся к тому, что было до неё.',
                  )}
                </p>
              </li>
              <li>
                <span aria-hidden="true">03</span>
                <h3>Без&nbsp;вашей просьбы&nbsp;— ничего лишнего</h3>
                <p>
                  {nbsp(
                    'Платить, удалять, вводить пароли и что-то менять на чужих сайтах Радити без вашей явной просьбы не станет.',
                  )}
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section id="pricing" className={styles.section} aria-labelledby="pricing-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="pricing-title">Тарифы</h2>
            <p className={styles.sectionNote}>
              {nbsp('Оплату пока не принимаем: сервис готовится к запуску.')}
            </p>
          </div>
          {pricing}
        </section>

        <LandingLead captchaSiteKey={captchaSiteKey} isGuest={isGuest} />

        <section
          id="faq"
          className={`${styles.section} ${styles.faqSection}`}
          aria-labelledby="faq-title"
        >
          <div className={`${styles.sectionHeading} ${styles.centred}`} data-reveal>
            <h2 id="faq-title">Вопросы</h2>
          </div>
          <div className={styles.questions}>
            {questions.map(({ question, answer }) => (
              // Until React takes the page over, `open` belongs to the browser: a link to a text
              // of an answer, a search on the page or an early press opens the question, and the
              // server could not know. React leaves the attribute as it is; this keeps it from
              // reporting the difference.
              <details key={question} className={styles.question} suppressHydrationWarning>
                <summary>
                  {nbsp(question)}
                  <span aria-hidden="true" />
                </summary>
                <p>{readable(answer)}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <Link href="/" aria-label="Радити — на главную">
            <span className={styles.wordmark}>
              <AnimatedBrandSymbol size={35} className={styles.logoSymbol} />
              Радити
            </span>
          </Link>
          <p>Ваши дела в&nbsp;заботливых руках.</p>
          <Link href={isGuest ? '/sign-in' : '/chats'}>
            {isGuest ? 'Войти' : 'Открыть чаты'} <LandingIcon name="arrow-up-right" {...arrow} />
          </Link>
        </div>
        <nav aria-label="Документы" className={styles.legalLinks}>
          {legalDocuments.map((document) => (
            <Link key={document.slug} href={legalDocumentHref(document.slug)}>
              {document.title}
            </Link>
          ))}
          {/* For the search engines and for whoever looks for a page by its name. */}
          <a href="/sitemap.xml">Карта сайта</a>
        </nav>
        <div className={styles.footerBottom}>
          <span>© {new Date().getFullYear()} Радити</span>
          <a href="#top">
            Вернуться наверх <LandingIcon name="arrow-up" size={16} strokeWidth={1.7} />
          </a>
        </div>
        <div className={styles.footerWord} aria-hidden="true">
          радити
          {/* CSS sizes the sign from the word; the number is the fallback of the attribute. */}
          <AnimatedBrandSymbol size={156} />
        </div>
      </footer>
    </div>
  )
}
