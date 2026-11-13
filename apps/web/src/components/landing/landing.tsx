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
import { LandingPlatforms } from './landing-platforms'
import { mainAction } from './main-action'
import { pluralCredits, typicalCreditsInWords } from './pricing-calculator'
import { SiteDemo } from './site-demo'
import styles from './landing.module.css'

// The arrows of the buttons and links: the size and stroke they had before the icons were gathered.
const arrow = { size: 20, strokeWidth: 1.7, linecap: 'round', linejoin: 'round' } as const

// A request is set as a message of the chat, so it needs no quotation marks. A result names what
// will stand on the site: a noun phrase, no past tense, no figure that the demo does not show.
const capabilities = [
  {
    name: 'Цены и тексты',
    request: 'Стрижка теперь 1 800 ₽, поправь в прайсе',
    result: 'Новая цена стрижки в прайсе',
  },
  {
    name: 'Фото и файлы',
    request: 'Замени меню на этот PDF',
    result: 'Новый файл меню на прежнем месте',
  },
  {
    name: 'Акции и баннеры',
    request: 'Напиши на главной: в выходные скидка 20% на всё',
    result: 'Плашка с акцией на главной странице',
  },
  {
    name: 'Страницы и разделы',
    request: 'Добавь раздел с нашими услугами',
    result: 'Раздел «Услуги» в стиле вашего сайта',
  },
  {
    name: 'Кнопки и формы',
    request: 'Добавь кнопку записи в шапку',
    result: 'Кнопка записи в шапке сайта',
  },
  {
    name: 'Заголовок и описание для поиска',
    request: 'Напиши в описании для поиска, что теперь готовим и завтраки',
    result: 'Новое описание страницы для поисковиков',
  },
]

// The order follows the visitor: does it suit me, what does it cost, what if it goes wrong, where
// the data lives. The page and the FAQPage markup of the search engines read this one list.
export const questions = [
  {
    question: 'Нужно разбираться в сайтах?',
    answer:
      'Нет. Пишите, как написали бы знакомому: «поменяй цену капучино на 290», «замени фото на главной». Если чего-то не хватит, Радити переспросит.',
  },
  {
    question: 'Мой сайт подойдёт?',
    answer:
      'Если он на WordPress, Joomla, OpenCart, MODX или 1С-Битрикс — да. Не знаете, на чём сделан сайт? Оставьте заявку — посмотрим сами.',
  },
  {
    // What the two commonest kinds of request cost: estimates of the credits model, so the answer
    // says «обычно»; the numbers are constants of the domain, as under the calculator. The rule
    // of the charge is the sentence of the tariffs, word for word (Ц14).
    question: 'Сколько стоит одна правка?',
    answer: `Работу мы считаем в кредитах. Поменять цену, текст или фото — обычно ${typicalCreditsInWords(typicalTaskCredits.small)}, добавить блок или страницу — ${typicalCreditsInWords(typicalTaskCredits.block, false)}. Сколько это в рублях, написано в карточке каждого тарифа. ${CHARGED_FOR_DONE_WORK}`,
  },
  {
    question: 'А если результат не понравится?',
    answer:
      'До публикации — скажите, что поправить, или отмените правку. После публикации её можно отменить в течение 7 дней: сайт вернётся к прежнему виду.',
  },
  {
    question: 'Где будут храниться данные?',
    answer:
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывает модель GLM провайдера Z.ai за рубежом; переданные ему копии могут храниться по условиям этого провайдера. Условия обработки данных описаны в документах сервиса.',
  },
]

// A hyphen or a slash lets the browser break the line inside a name, and so does a dash between
// the figures of a range: «15–» would end a line and «25» start the next.
const UNBREAKABLE = /(1С-Битрикс|\d+–\d+)/

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
          `${signupGiftCredits} ${pluralCredits(signupGiftCredits)} в подарок — около ${giftTaskCounts(signupGiftCredits).small} небольших правок`,
        ]
      : []),
    'Подключение бесплатно',
    'Подключаем сами',
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
            {readable('ИИ-помощник для сайта на WordPress, Joomla, OpenCart, MODX и 1С-Битрикс')}
          </h1>
          <p className={styles.heroTitle}>
            <span>Напишите в&nbsp;чат.</span>{' '}
            <span>
              <em>Сайт поправим.</em>
            </span>
          </p>
          <p className={styles.heroLead}>
            {nbsp(
              'Цены, фото, акции, часы работы. Напишите обычными словами, что поменять, — Радити сделает и покажет до публикации.',
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
              {nbsp('Сайт кофейни для примера. Выберите просьбу — и посмотрите, что изменится.')}
            </p>
          </div>
          <SiteDemo />
        </section>

        <LandingPlatforms />

        <section id="possibilities" className={styles.section} aria-labelledby="can-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="can-title">Что можно поручить</h2>
            <p>
              {nbsp(
                'То, ради чего обычно пишут разработчику: ваша просьба — и что после неё появится на сайте.',
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
                <span className={styles.columnLabel}>Что изменится на&nbsp;сайте</span>
                <p className={styles.capabilityResult}>{nbsp(item.result)}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="safety" className={styles.safety} aria-labelledby="safety-title">
          <div className={styles.safetyInner}>
            <div className={styles.sectionHeading} data-reveal>
              <h2 id="safety-title">Без&nbsp;вашего «да» сайт не&nbsp;меняется</h2>
              <p>{nbsp('Правка сначала появляется в черновике. На сайт её выпускаете вы.')}</p>
            </div>
            <ol className={styles.safetyList} role="list">
              <li>
                <span aria-hidden="true">01</span>
                <h3>Сначала черновик</h3>
                <p>
                  {nbsp(
                    'Радити показывает правку на копии сайта. Посетители её не видят, пока вы не опубликуете.',
                  )}
                </p>
              </li>
              <li>
                <span aria-hidden="true">02</span>
                <h3>Отмена за&nbsp;7&nbsp;дней</h3>
                <p>
                  {nbsp(
                    'Опубликовали и передумали — отмените в чате. Сайт вернётся к прежнему виду.',
                  )}
                </p>
              </li>
              <li>
                <span aria-hidden="true">03</span>
                <h3>Опасное&nbsp;— только с&nbsp;подтверждением</h3>
                <p>
                  {nbsp(
                    'Удалить страницы, сменить оформление, поставить дополнения Радити без вашего отдельного согласия не станет.',
                  )}
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section id="pricing" className={styles.section} aria-labelledby="pricing-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="pricing-title">Тарифы</h2>
            <p>{nbsp('Подвиньте ползунок — подберём тариф под число ваших задач.')}</p>
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
          <p>Ваш сайт в&nbsp;заботливых руках.</p>
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
