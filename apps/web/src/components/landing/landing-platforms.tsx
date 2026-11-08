'use client'

import { useState } from 'react'

import { nbsp } from '@/lib/nbsp'

import styles from './platforms.module.css'

// The systems the landing names as available (the owner, 08.11.2026,
// docs/plan/65-landing-platforms-leads.md, Л2), in the owner's order. A request is set as a message of
// the chat; a result names what will stand on the site, as the capabilities above do.
export const platforms = [
  {
    name: 'WordPress',
    mark: 'W',
    parts: 'Новости, страницы, фото',
    request: 'Добавь новость о летнем меню',
    result: 'Новая запись в разделе «Новости»',
  },
  {
    name: 'Joomla',
    mark: 'J',
    parts: 'Статьи, меню, блоки',
    request: 'Поменяй телефон в шапке сайта',
    result: 'Новый номер в шапке сайта',
  },
  {
    name: 'OpenCart',
    mark: 'OC',
    parts: 'Товары, категории, цены',
    request: 'Подними цены на кофе на 10%',
    result: 'Новые цены в категории «Кофе»',
  },
  {
    name: 'MODX',
    mark: 'M',
    parts: 'Страницы, меню, блоки',
    request: 'Сделай страницу «Доставка»',
    result: 'Страница «Доставка» в меню сайта',
  },
  {
    name: '1С-Битрикс',
    mark: '1С',
    parts: 'Новости, каталог, баннеры',
    request: 'Замени баннер на главной',
    result: 'Новый слайд в баннере главной',
  },
] as const

/**
 * «Пять систем. Один чат.»: the five systems as rows of a board on the chocolate field. The
 * chosen row lies on the amber plate, and the card beside it shows what one asks of that system
 * and what changes on the site. Without scripts the first row is chosen and the rows do nothing.
 */
export function LandingPlatforms() {
  const [chosen, setChosen] = useState(0)
  const current = platforms[chosen] ?? platforms[0]
  return (
    <section id="platforms" className={styles.platforms} aria-labelledby="platforms-title">
      <div className={styles.inner}>
        <div className={styles.heading} data-reveal>
          <div>
            <span className={styles.label}>Платформы</span>
            <h2 id="platforms-title">
              Пять систем.
              <br />
              <em>Один чат.</em>
            </h2>
          </div>
          <p>
            {nbsp(
              'Радити знает, как устроена каждая из них, и правит так, как в ней принято. Выберите свою — покажем пример.',
            )}
          </p>
        </div>
        <div className={styles.board}>
          {/* The role is written out: without its markers Safari stops reading a list as one. */}
          <ul className={styles.rows} role="list" aria-label="Поддерживаемые системы">
            {platforms.map((platform, index) => (
              <li key={platform.name}>
                <button
                  type="button"
                  className={styles.row}
                  aria-pressed={index === chosen}
                  aria-controls="platform-example"
                  onClick={() => setChosen(index)}
                >
                  <span className={styles.number}>{String(index + 1).padStart(2, '0')}</span>
                  {/* A name with a hyphen stays in one piece. */}
                  <span className={`${styles.name} ${styles.nowrap}`}>{platform.name}</span>
                  <span className={styles.parts}>{platform.parts}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.example} id="platform-example" aria-live="polite">
            <svg className={styles.sign} viewBox="0 0 60 60" aria-hidden="true" focusable="false">
              <circle cx="30" cy="30" r="30" />
              <path d="M30 17.5v25M19.175 23.75l21.65 12.5M19.175 36.25l21.65-12.5" />
            </svg>
            <div className={styles.system}>
              <span className={styles.mark} aria-hidden="true">
                {current.mark}
              </span>
              <span>
                <small>Пример для</small>
                <strong className={styles.nowrap}>{current.name}</strong>
              </span>
            </div>
            {/* The key replays the entrance of the example when another system is chosen. */}
            <div key={current.name} className={styles.exchange}>
              <span className={styles.caption}>Например, вы&nbsp;пишете</span>
              <p className={styles.request}>{nbsp(current.request)}</p>
              <span className={styles.caption}>Что изменится на&nbsp;сайте</span>
              <p className={styles.result}>{nbsp(current.result)}</p>
            </div>
            <ul className={styles.promises} role="list">
              <li>Копия до&nbsp;правки</li>
              <li>Предпросмотр</li>
              <li>Отмена в&nbsp;один шаг</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
