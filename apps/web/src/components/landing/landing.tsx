import { legalDocuments } from '@repo/domain'
import { BrandSymbol } from '@repo/ui/brand-symbol'
import Link from 'next/link'
import type { ReactNode } from 'react'

import type { LandingViewer } from '@/server/landing-viewer'

import { LandingHeader } from './landing-header'
import { LandingMotion } from './landing-motion'
import { SafetyDemo } from './safety-demo'
import { SiteDemo } from './site-demo'
import styles from './landing.module.css'

export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={diagonal ? 'M6 18 18 6M6 6h12v12' : 'M4 12h15m-6-6 6 6-6 6'}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const capabilities = [
  {
    name: 'Цены и тексты',
    request: '«Подними цену на капучино до 290 ₽»',
    description: 'Актуальное меню, свежий прайс и ни одной забытой цифры.',
  },
  {
    name: 'Фото и файлы',
    request: '«Замени меню на этот PDF»',
    description: 'Новые фотографии, документы и материалы — на своих местах.',
  },
  {
    name: 'Акции и баннеры',
    request: '«Расскажи о скидке в выходные»',
    description: 'Ваше предложение заметят, как только откроют сайт.',
  },
  {
    name: 'Страницы и блоки',
    request: '«Добавь блок с нашими услугами»',
    description: 'Бизнес растёт. Сайт успевает за ним.',
  },
  {
    name: 'Кнопки и формы',
    request: '«Добавь кнопку записи в шапку»',
    description: 'Меньше шагов между интересом и обращением.',
  },
  {
    name: 'Заголовки для поиска',
    request: '«Обнови описание страницы»',
    description: 'Чтобы поисковики понимали, чем вы занимаетесь.',
  },
]

const questions = [
  {
    question: 'Для каких сайтов подойдёт Радити?',
    answer:
      'Начинаем с сайтов малого бизнеса на WordPress: кафе, студий, локальных магазинов и сервисных компаний. Поддержка 1С-Битрикс и других платформ — в планах.',
  },
  {
    question: 'Нужно разбираться в коде?',
    answer:
      'Нет. Идея Радити — описывать задачу обычными словами: какую цену поменять, где заменить фото или что добавить на страницу. Агент уточнит детали и покажет результат. Сейчас этот сценарий можно попробовать в демо выше.',
  },
  {
    question: 'Что, если результат не понравится?',
    answer:
      'Мы строим работу вокруг сохранённой версии: снимок перед изменением, проверка после и возможность отмены. В демо можно применить правку и вернуть всё обратно. Полный цикл на подключённых сайтах готовится к запуску.',
  },
  {
    question: 'Что считается правкой?',
    answer:
      'В основе тарифа — задача по изменению сайта: например, обновить цену или добавить баннер. Дополнительные пакеты увеличивают месячный лимит. Подробные условия списаний будут доступны перед подключением оплаты.',
  },
  {
    question: 'Где будут храниться данные?',
    answer:
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывают модели OpenAI и Moonshot за рубежом; переданные им копии могут храниться по условиям этих провайдеров. Условия обработки данных описаны в документах сервиса.',
  },
  {
    question: 'Можно уже подключить сайт и оплатить?',
    answer:
      'Пока открыт ранний доступ: можно создать аккаунт и познакомиться с интерфейсом. Подключение сайтов, выполнение задач и оплата готовятся к запуску. Демо на этой странице работает локально и не меняет ваш сайт.',
  },
]

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
      <LandingMotion />
      <a href="#main-content" className={styles.skip}>
        Перейти к содержанию
      </a>
      <LandingHeader viewer={viewer} />
      <main id="main-content">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroGrid}>
            <div className={styles.heroCopy}>
              <h1 id="hero-title" className={styles.heroTitle}>
                <span>Напишите</span>
                <span>
                  в <em>чат.</em>
                </span>
                <span className={styles.heroLast}>Сайт поправим.</span>
              </h1>
              <p className={styles.heroLead}>
                Забота о сайте вашего бизнеса. Обновить цены, заменить фото, добавить акцию — просто
                скажите, что изменить.
              </p>
              <div className={styles.heroActions}>
                <Link href={actionHref} className={styles.primaryButton}>
                  {isGuest ? 'Начать с Радити' : 'Открыть проекты'} <Arrow diagonal />
                </Link>
                <a href="#site-demo" className={styles.textLink}>
                  Попробовать демо{' '}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 4v16m-6-6 6 6 6-6" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                </a>
              </div>
              <div className={styles.heroFootnote}>
                <span className={styles.accessStatus}>
                  <i />
                  Ранний доступ · пока без подключения сайта
                </span>
                <span className={styles.heroPromise}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  <span>Вы занимаетесь бизнесом. Мы заботимся о сайте.</span>
                </span>
              </div>
            </div>
            <div className={styles.heroDemo}>
              <SiteDemo />
            </div>
          </div>
          <div className={styles.heroBottom}>
            <span>Меньше рутины. Больше своего дела.</span>
            <a href="#possibilities">
              Посмотреть возможности <Arrow />
            </a>
          </div>
        </section>

        <section className={styles.statement} aria-label="Поддержка сайта одним сообщением">
          <div className={styles.statementInner}>
            <p>
              «Надо найти разработчика.
              <br />
              Объяснить. Напомнить. Подождать».
            </p>
            <div className={styles.statementAnswer}>
              <span className={styles.drawnArrow} aria-hidden="true">
                <Arrow />
              </span>
              <h2>
                А можно
                <br />
                <em>просто написать.</em>
              </h2>
            </div>
          </div>
          <div className={styles.requestStrip} aria-label="Примеры задач">
            <span>Обнови цены</span>
            <span>Замени фото</span>
            <span>Добавь акцию</span>
            <span>Поменяй часы работы</span>
          </div>
        </section>

        <section id="how" className={styles.section} aria-labelledby="how-title">
          <div className={styles.sectionHeading}>
            <h2 id="how-title">
              От «надо поправить»
              <br />
              до «уже готово».
            </h2>
            <p>
              Без технических заданий на десять страниц. Вот как будет устроена работа с Радити.
            </p>
          </div>
          <div className={styles.steps}>
            <article className={styles.step}>
              <span className={styles.stepNumber}>01</span>
              <h3>Подключите сайт</h3>
              <p>Познакомьте Радити с вашим сайтом. Начинаем с WordPress.</p>
              <div className={styles.connectVisual}>
                <span className={styles.wpMark} aria-hidden="true">
                  W
                </span>
                <span className={styles.connectLine} />
                <Wordmark />
              </div>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>02</span>
              <h3>Скажите, что изменить</h3>
              <p>Напишите задачу обычными словами. Так, как написали бы коллеге.</p>
              <div className={styles.requestVisual}>
                В субботу работаем до 18:00.
                <br />
                Обнови, пожалуйста, на сайте.<span>Вы</span>
              </div>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>03</span>
              <h3>Посмотрите результат</h3>
              <p>Проверьте правку и решите, применять ли её. Последнее слово — за вами.</p>
              <div className={styles.resultVisual}>
                <span>
                  <i /> Правка готова к проверке
                </span>
                <span className={styles.resultPill}>
                  Применить <Arrow />
                </span>
              </div>
            </article>
          </div>
        </section>

        <section
          id="possibilities"
          className={`${styles.section} ${styles.capabilitiesSection}`}
          aria-labelledby="can-title"
        >
          <div className={styles.sectionHeading}>
            <h2 id="can-title">
              Маленькие правки.
              <br />
              <span className={styles.highlight}>Большая разница.</span>
            </h2>
            <p>
              Всё, ради чего вы обычно ищете подрядчика. Сценарии, которые мы готовим к запуску.
            </p>
          </div>
          <div className={styles.capabilities}>
            {capabilities.map((item) => (
              <article key={item.name} className={styles.capability}>
                <h3>{item.name}</h3>
                <p className={styles.requestQuote}>{item.request}</p>
                <p>{item.description}</p>
              </article>
            ))}
          </div>
          <div className={styles.capabilitiesNote}>
            <span>Сначала — WordPress.</span>
            <span>Затем — другие платформы, на которых живёт ваш бизнес.</span>
          </div>
        </section>

        <section id="safety" className={styles.safety} aria-labelledby="safety-title">
          <div className={styles.safetyInner}>
            <div className={styles.safetyCopy}>
              <h2 id="safety-title">
                Смело меняйте.
                <br />
                <em>Всё обратимо.</em>
              </h2>
              <p>
                Хорошая забота — это когда спокойно. Поэтому сохраняем прошлую версию и оставляем
                контроль у вас.
              </p>
              <ul className={styles.safetyList}>
                <li>
                  <span>Сначала — снимок</span>
                  <p>Сохраняем то, что предстоит изменить.</p>
                </li>
                <li>
                  <span>Затем — проверка</span>
                  <p>Смотрим, что получилось после правки.</p>
                </li>
                <li>
                  <span>Не нравится — отмена</span>
                  <p>Возвращаем предыдущую версию.</p>
                </li>
              </ul>
              <p className={styles.safetyNote}>
                Так будет устроена защита сайта. Попробуйте отмену в демо.
              </p>
            </div>
            <SafetyDemo />
          </div>
        </section>

        <section id="pricing" className={styles.section} aria-labelledby="pricing-title">
          <div className={styles.sectionHeading}>
            <h2 id="pricing-title">
              Забота по размеру
              <br />
              вашего бизнеса.
            </h2>
            <p>
              Один сайт или целое портфолио.
              <br />
              Подберите свой объём правок.
            </p>
          </div>
          {pricing}
        </section>

        <section
          id="faq"
          className={`${styles.section} ${styles.faqSection}`}
          aria-labelledby="faq-title"
        >
          <div className={styles.faqIntro}>
            <h2 id="faq-title">Хороший вопрос.</h2>
            <p>
              Всё, что стоит знать <br />
              до знакомства с Радити.
            </p>
            <div className={styles.faqSymbol} aria-hidden="true">
              ?
            </div>
          </div>
          <div className={styles.questions}>
            {questions.map(({ question, answer }) => (
              <details key={question} className={styles.question}>
                <summary>
                  {question}
                  <span aria-hidden="true" />
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="start-title">
          <div className={styles.finalInner}>
            <div>
              <h2 id="start-title">
                У вас есть дело.
                <br />У сайта есть <span>Радити.</span>
              </h2>
              <p>Освободите время для того, что любите.</p>
            </div>
            <Link href={actionHref} className={styles.finalButton}>
              {isGuest ? 'Познакомиться' : 'Открыть проекты'}
              <Arrow diagonal />
            </Link>
          </div>
          <div className={styles.finalMeta}>
            <span>Ранний доступ · WordPress</span>
            <span>С заботой о вашем деле</span>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <Link href="/" aria-label="Радити — на главную">
            <Wordmark />
          </Link>
          <p>Ваш сайт в заботливых руках.</p>
          <Link href={isGuest ? '/sign-in' : '/projects'}>
            {isGuest ? 'Войти' : 'Открыть проекты'} <Arrow diagonal />
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
            Вернуться наверх{' '}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 20V4m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          </a>
        </div>
        <div className={styles.footerWord} aria-hidden="true">
          радити
          <svg viewBox="0 0 100 100" fill="none">
            <path d="M15 85 85 15M15 15h70v70" stroke="currentColor" strokeWidth="8" />
          </svg>
        </div>
      </footer>
    </div>
  )
}
