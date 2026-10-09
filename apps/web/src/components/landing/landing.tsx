import { legalDocuments } from '@repo/domain'
import { BrandSymbol } from '@repo/ui/brand-symbol'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { nbsp } from '@/lib/nbsp'
import type { LandingViewer } from '@/server/landing-viewer'

import { LandingAnchor } from './landing-anchor'
import { LandingHeader } from './landing-header'
import { LandingIcon } from './landing-icons'
import { LandingMotion } from './landing-motion'
import { cafe, story } from './landing-story'
import { SafetyDemo } from './safety-demo'
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

// The order follows the visitor: does it suit me and what can I do now, how to use it and what
// counts, what happens to the site and the data.
const questions = [
  {
    question: 'Для каких сайтов подойдёт Радити?',
    answer:
      'Начинаем с сайтов малого бизнеса на WordPress: кафе, студий, локальных магазинов и сервисных компаний. Поддержка 1С-Битрикс и других систем — в планах. Не знаете, на чём сделан ваш сайт? Спросите у того, кто его делал. Частый признак WordPress — адрес входа в панель управления сайтом заканчивается на /wp-admin.',
  },
  {
    question: 'Можно уже подключить сайт и оплатить?',
    answer:
      'Пока нет. Сейчас можно зарегистрироваться и посмотреть личный кабинет. Подключение сайтов, выполнение задач и оплата откроются позже. Пример на этой странице работает только в вашем браузере и ничего не меняет на вашем сайте.',
  },
  {
    question: 'Что понадобится, чтобы подключить сайт?',
    answer:
      'Как подключать сайт, покажем по шагам, когда откроем подключение, и заранее скажем, что понадобится.',
  },
  {
    question: 'Нужно разбираться в коде?',
    answer:
      'Нет. Задачу нужно будет описать обычными словами: какую цену поменять, где заменить фото, что добавить на страницу. Радити уточнит детали и покажет результат. Как это выглядит, можно попробовать уже сейчас — на примере вверху страницы.',
  },
  {
    question: 'Что считается правкой?',
    answer:
      'В основе тарифа — задача по изменению сайта: например, обновить цену или добавить баннер. Дополнительные пакеты увеличивают месячный лимит. Подробные условия списаний будут доступны перед подключением оплаты.',
  },
  {
    question: 'Что, если результат не понравится?',
    answer:
      'Так задумано: перед каждой правкой Радити будет сохранять копию, а после — проверять, что получилось. Не понравилось — отмените правку, и мы вернём как было. На примере вверху страницы это уже можно попробовать; для настоящих сайтов — после запуска.',
  },
  {
    question: 'Что Радити не будет делать без вашего подтверждения?',
    answer:
      'Удалять страницы, менять оформление сайта, ставить дополнения и править сразу много страниц Радити будет только после вашего отдельного подтверждения.',
  },
  {
    question: 'Где будут храниться данные?',
    answer:
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывают модели OpenAI и Moonshot за рубежом; переданные им копии могут храниться по условиям этих провайдеров. Условия обработки данных описаны в документах сервиса.',
  },
]

// A hyphen or a slash lets the browser break the line inside a name.
const UNBREAKABLE = /(1С-Битрикс|\/wp-admin)/

/** Readable text with non-breaking spaces and with the unbreakable names kept in one piece. */
function readable(text: string): ReactNode {
  return nbsp(text)
    .split(UNBREAKABLE)
    .map((part, index) =>
      // The split puts the names at the odd places.
      index % 2 === 1 ? (
        <span key={index} className={styles.nowrap}>
          {part}
        </span>
      ) : (
        part
      ),
    )
}

function Wordmark() {
  return (
    <span className={styles.wordmark}>
      <BrandSymbol size={35} className={styles.logoSymbol} />
      Радити
    </span>
  )
}

export function Landing({ pricing, viewer }: { pricing: ReactNode; viewer: LandingViewer }) {
  const isGuest = viewer.status === 'guest'
  const actionHref = isGuest ? '/sign-up' : '/projects'
  return (
    <div className={styles.page} id="top">
      {/* Raises the elements marked with `data-reveal` as they come into the window. */}
      <LandingMotion />
      {/* The plans arrive after the page: a link to an anchor below them is put right then. */}
      <LandingAnchor after="pricing" />
      <a href="#main-content" className={styles.skip}>
        Перейти к содержанию
      </a>
      <LandingHeader viewer={viewer} />
      <main id="main-content">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <h1 id="hero-title" className={styles.heroTitle}>
                <span>Напишите</span>{' '}
                <span>
                  в&nbsp;<em>чат.</em>
                </span>{' '}
                <span className={styles.heroLast}>Сайт поправим.</span>
              </h1>
              <p className={styles.heroLead}>
                {nbsp(
                  'Радити — ИИ-помощник для сайта вашего бизнеса. Обновить цены, заменить фото, добавить акцию — просто напишите, что изменить.',
                )}
              </p>
              <div className={styles.heroActions}>
                <Link href={actionHref} className={styles.primaryButton}>
                  {isGuest ? 'Зарегистрироваться' : 'Открыть проекты'}{' '}
                  <LandingIcon name="arrow-up-right" {...arrow} />
                </Link>
                <a href="#site-demo" className={styles.textLink}>
                  Попробовать демо <LandingIcon name="arrow-down" size={16} strokeWidth={1.7} />
                </a>
              </div>
              {/* Only a guest is told to register: the action above leads the others to their
                  projects. */}
              <p className={styles.heroFootnote}>
                {nbsp(
                  isGuest
                    ? 'Сервис готовится к запуску. Сейчас можно попробовать пример и зарегистрироваться; подключение сайта и оплата откроются позже.'
                    : 'Сервис готовится к запуску. Сейчас можно попробовать пример; подключение сайта и оплата откроются позже.',
                )}
              </p>
            </div>
            <div className={styles.heroDemo}>
              <SiteDemo />
            </div>
          </div>
          <div className={styles.heroBottom}>
            <a href="#possibilities">
              Посмотреть возможности <LandingIcon name="arrow-right" {...arrow} />
            </a>
          </div>
        </section>

        <section className={styles.statement} aria-label="Поддержка сайта одним сообщением">
          <div className={styles.statementInner}>
            {/* The chores that one message replaces: a list that is being crossed out. The lines
                are drawn one after another when the block comes into the window. */}
            <p className={styles.chores} data-reveal="scene">
              <span>Надо найти разработчика.</span> <span>Объяснить.</span> <span>Напомнить.</span>{' '}
              <span>Подождать.</span>
            </p>
            <div className={styles.statementAnswer}>
              <span className={styles.drawnArrow} aria-hidden="true">
                <LandingIcon name="arrow-right" {...arrow} />
              </span>
              <h2>
                А&nbsp;можно
                <br />
                <em>просто написать.</em>
              </h2>
            </div>
          </div>
          {/* The role is written out: without its markers Safari stops reading a list as one. */}
          <ul className={styles.requestStrip} role="list" aria-label="Примеры задач">
            <li>Обнови цены</li>
            <li>Замени фото</li>
            <li>Добавь акцию</li>
            <li>Поменяй часы работы</li>
          </ul>
        </section>

        <section id="how" className={styles.section} aria-labelledby="how-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="how-title">
              От&nbsp;«надо поправить»
              <br />
              до&nbsp;«уже готово».
            </h2>
            <div className={`${styles.sectionLead} ${styles.stepsLead}`}>
              <span className={styles.launchLabel}>После запуска</span>
              <p>
                {nbsp(
                  'Без технических заданий на десять страниц. Вот как будет устроена работа с Радити.',
                )}
              </p>
            </div>
          </div>
          <div className={styles.steps}>
            <article className={styles.step}>
              <span className={styles.stepNumber}>01</span>
              <h3>Подключите сайт</h3>
              <p>
                {nbsp(
                  'Подключение откроется позже. Мы проведём вас по шагам и заранее скажем, что понадобится. Начинаем с сайтов на WordPress.',
                )}
              </p>
              {/* Frame 1 of one change: the site as it is. No button and no promise of a
                  connection in one click: connecting is not open yet. */}
              <div
                className={styles.stepExample}
                role="img"
                aria-label={`Пример: сайт кофейни, ${story.inWords.field} — ${story.inWords.before}`}
              >
                <span className={styles.exampleLabel}>Пример</span>
                <div className={styles.frame}>
                  <div className={styles.siteBar}>
                    <span className={styles.siteDots}>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className={styles.siteAddress}>{cafe.address}</span>
                  </div>
                  <div className={styles.siteBody}>
                    <span className={styles.siteName}>{cafe.name}</span>
                    <div className={styles.siteRow}>
                      <span>
                        {cafe.item} <small>{cafe.volume}</small>
                      </span>
                      <strong>{story.before}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>02</span>
              <h3>Скажите, что изменить</h3>
              <p>
                {nbsp(
                  'Напишите задачу в чате личного кабинета — обычными словами, как написали бы коллеге.',
                )}
              </p>
              {/* Frame 2: the message of the owner. A scene: the message comes in when the
                  frame enters the window. */}
              <div
                className={styles.stepExample}
                role="img"
                aria-label={`Пример сообщения в чате: ${story.inWords.request}`}
                data-reveal="scene"
              >
                <span className={styles.exampleLabel}>Пример</span>
                <div className={`${styles.frame} ${styles.messageFrame}`}>
                  <span className={styles.messageAuthor}>Вы</span>
                  <span className={styles.frameMessage}>{story.request}</span>
                </div>
              </div>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>03</span>
              <h3>Посмотрите результат</h3>
              <p>
                {nbsp(
                  'Посмотрите, что получилось. Последнее слово — за вами: правку можно отменить.',
                )}
              </p>
              {/* Frame 3: the difference, told in words too, with no status of success and
                  nothing to press. A scene: the new value comes in, then its amber plate. */}
              <div
                className={styles.stepExample}
                role="img"
                aria-label={`Пример: ${story.inWords.field} — было ${story.inWords.before}, стало ${story.inWords.after}`}
                data-reveal="scene"
              >
                <span className={styles.exampleLabel}>Пример</span>
                <div className={`${styles.frame} ${styles.diffFrame}`}>
                  <span className={styles.diffField}>{story.field}</span>
                  <div className={styles.diffPair}>
                    <span className={styles.diffValue}>
                      <small>Было</small>
                      <s>{story.before}</s>
                    </span>
                    <span className={styles.diffValue}>
                      <small>Стало</small>
                      <strong>{story.after}</strong>
                    </span>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section
          id="possibilities"
          className={`${styles.section} ${styles.capabilitiesSection}`}
          aria-labelledby="can-title"
        >
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="can-title">
              Маленькие правки.
              <br />
              <em className={styles.highlight}>Большая разница.</em>
            </h2>
            <div className={styles.sectionLead}>
              <p>
                {nbsp(
                  'То, ради чего обычно приходится искать подрядчика. Эти задачи Радити будет выполнять после запуска.',
                )}
              </p>
            </div>
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
          <div className={styles.capabilitiesNote}>
            <span>Сначала&nbsp;— WordPress.</span>
            <span>{readable('Другие системы, например 1С-Битрикс, — в планах.')}</span>
          </div>
        </section>

        <section id="safety" className={styles.safety} aria-labelledby="safety-title">
          <div className={styles.safetyInner}>
            <div className={styles.safetyCopy} data-reveal>
              <h2 id="safety-title">
                Смело меняйте.
                <br />
                <em className={styles.highlight}>Есть отмена.</em>
              </h2>
              <p>
                {nbsp(
                  'Хорошая забота — это когда спокойно. Поэтому сначала сохраним копию, а решение оставим за вами.',
                )}
              </p>
              <ul className={styles.safetyList}>
                <li>
                  <span>Сначала&nbsp;— копия</span>
                  <p>Сохраним то, что предстоит изменить.</p>
                </li>
                <li>
                  <span>Затем&nbsp;— посмотрим сами</span>
                  <p>Откроем страницу после правки и&nbsp;проверим, что получилось.</p>
                </li>
                <li>
                  <span>Не&nbsp;понравилось&nbsp;— отмените</span>
                  <p>Вернём как было.</p>
                </li>
              </ul>
            </div>
            {/* The card and, after it, the note: both are children of this grid. */}
            <SafetyDemo />
          </div>
        </section>

        <section id="pricing" className={styles.section} aria-labelledby="pricing-title">
          <div className={styles.sectionHeading} data-reveal>
            <h2 id="pricing-title">
              Забота по&nbsp;размеру
              <br />
              вашего бизнеса.
            </h2>
            <div className={styles.sectionLead}>
              <p>
                Один сайт или несколько.
                <br />
                Подберите свой объём правок.
              </p>
              <p className={styles.sectionNote}>
                {nbsp('Оплату пока не принимаем: сервис готовится к запуску.')}
              </p>
            </div>
          </div>
          {pricing}
        </section>

        <section
          id="faq"
          className={`${styles.section} ${styles.faqSection}`}
          aria-labelledby="faq-title"
        >
          <div className={styles.faqIntro} data-reveal>
            <h2 id="faq-title">Хороший вопрос.</h2>
            <p>
              Всё, что стоит знать <br />
              до&nbsp;знакомства с&nbsp;Радити.
            </p>
            <div className={styles.faqSymbol} aria-hidden="true">
              ?
            </div>
          </div>
          <div>
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

        <section className={styles.finalCta} aria-labelledby="start-title">
          <div className={styles.finalInner}>
            <div>
              <h2 id="start-title" data-reveal>
                У&nbsp;вас есть дело.
                <br />
                У&nbsp;сайта есть Радити.
              </h2>
              <p>
                {isGuest
                  ? nbsp('Зарегистрируйтесь сейчас — подключение сайта откроется позже.')
                  : 'Подключение сайта откроется позже.'}
              </p>
            </div>
            <Link href={actionHref} className={`${styles.primaryButton} ${styles.finalButton}`}>
              {isGuest ? 'Зарегистрироваться' : 'Открыть проекты'}
              <LandingIcon name="arrow-up-right" {...arrow} />
            </Link>
          </div>
          <div className={styles.finalMeta}>
            <span>{nbsp('Сервис готовится к запуску · пока для сайтов на WordPress')}</span>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <Link href="/" aria-label="Радити — на главную">
            <Wordmark />
          </Link>
          <p>Ваш сайт в&nbsp;заботливых руках.</p>
          <Link href={isGuest ? '/sign-in' : '/projects'}>
            {isGuest ? 'Войти' : 'Открыть проекты'} <LandingIcon name="arrow-up-right" {...arrow} />
          </Link>
        </div>
        <nav aria-label="Юридические документы" className={styles.legalLinks}>
          {legalDocuments.map((document) => (
            <Link key={document.slug} href={`/terms/${document.slug}`}>
              {document.title}
            </Link>
          ))}
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
          <BrandSymbol size={156} />
        </div>
      </footer>
    </div>
  )
}
