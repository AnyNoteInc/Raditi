import { nbsp } from '@/lib/nbsp'

import { LandingIcon } from './landing-icons'
import styles from './landing.module.css'
import { MAIN_ACTION_SHORT } from './main-action'

// The systems the landing names as available (the owner, 08.11.2026,
// docs/plan/65-landing-platforms-leads.md, Л2), in the owner's order.
export const platforms = ['WordPress', 'Joomla', 'OpenCart', 'MODX', '1С-Битрикс'] as const

// Two lines run towards each other; every second name is drawn as an outline. A line is written
// twice: the second half follows the first, so the run has no seam.
const lines = [
  { names: ['WordPress', 'Joomla', 'OpenCart'], sign: styles.signAmber },
  { names: ['MODX', '1С-Битрикс', 'WordPress'], sign: styles.signInk },
] as const

/**
 * «На чём сделан ваш сайт?»: the five systems as a running line on the orange field. The line is
 * an ornament, hidden from a screen reader; the names stand in the text under the heading and in
 * a list that is heard and not seen, so a robot and a reader take them without the motion.
 */
export function LandingPlatforms() {
  return (
    <section id="platforms" className={styles.platforms} aria-labelledby="platforms-title">
      <div className={styles.platformsInner}>
        <div className={styles.sectionHeading} data-reveal>
          <h2 id="platforms-title">
            На&nbsp;чём сделан ваш сайт?
            <br />
            <em className={styles.highlight}>Скорее всего, подойдёт.</em>
          </h2>
          <p>
            <span className={styles.nowrap}>WordPress,</span> Joomla, OpenCart, MODX и&nbsp;
            <span className={styles.nowrap}>1С-Битрикс</span>&nbsp;— Радити работает с&nbsp;каждой
            из&nbsp;этих систем.
          </p>
        </div>
      </div>
      {/* The role is written out: without its markers Safari stops reading a list as one. */}
      <ul data-sr-only role="list" aria-label="Поддерживаемые системы">
        {platforms.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <div className={styles.marquee} aria-hidden="true">
        {lines.map(({ names, sign }, line) => (
          <div key={line} className={styles.marqueeLine} data-reverse={line === 1}>
            {[...names, ...names].map((name, index) => (
              <span key={index} className={styles.marqueeItem}>
                <span className={styles.marqueeName} data-outline={(index + line) % 2 === 1}>
                  {name}
                </span>
                <svg className={sign} viewBox="0 0 60 60" focusable="false">
                  <circle cx="30" cy="30" r="30" />
                  <path d="M30 17.5v25M19.175 23.75l21.65 12.5M19.175 36.25l21.65-12.5" />
                </svg>
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.platformsInner}>
        <div className={styles.platformsFoot}>
          <div className={styles.platformsTalk}>
            <p className={styles.platformsAsk}>
              {nbsp('У меня магазин на OpenCart. Это подойдёт?')}
            </p>
            <p className={styles.platformsAnswer}>
              {nbsp('Подойдёт. Подключим и настроим бесплатно.')}
            </p>
          </div>
          <a href="#lead" className={styles.primaryButton}>
            {MAIN_ACTION_SHORT}{' '}
            <LandingIcon
              name="arrow-right"
              size={20}
              strokeWidth={1.7}
              linecap="round"
              linejoin="round"
            />
          </a>
        </div>
      </div>
    </section>
  )
}
