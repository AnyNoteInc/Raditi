import { legalDocuments } from '@repo/domain'
import { AnimatedBrandSymbol } from '@repo/ui/animated-brand-symbol'
import Link from 'next/link'

import { LandingIcon } from '@/components/landing/landing-icons'
import { landingNavigation } from '@/components/landing/landing-navigation'
import { SITE_EMAIL, SITE_OPERATOR, SITE_PHONE } from '@/lib/contacts'
import { legalDocumentHref } from '@/lib/legal'

import { CookieSettingsButton } from './cookie-banner'
import styles from './public-footer.module.css'

const arrow = { size: 20, strokeWidth: 1.7, linecap: 'round', linejoin: 'round' } as const
const contactIcon = { size: 18, strokeWidth: 1.7, linecap: 'round', linejoin: 'round' } as const

/**
 * The footer of the public pages, the landing and the documents alike (the owner, 15.11.2026):
 * built as the footer of AnyNote — the brand, «Продукт», «Документы» and «Контакты» in columns,
 * a line, the copyright with the service links — and closed, as before, by the word of the brand
 * across the whole width.
 *
 * The way in is the sign-in for a guest and the chats for anybody else; a document does not ask
 * who reads it, so its footer offers the sign-in, as its header does.
 */
export function PublicFooter({ isGuest = true }: { isGuest?: boolean }) {
  return (
    <footer className={styles.footer}>
      <div className={styles.columns}>
        <div className={styles.brand}>
          <Link href="/" aria-label="Радити — на главную" className={styles.wordmark}>
            <AnimatedBrandSymbol size={35} className={styles.logoSymbol} />
            Радити
          </Link>
          <Link href={isGuest ? '/sign-in' : '/chats'} className={styles.wayIn}>
            {isGuest ? 'Войти' : 'Открыть чаты'} <LandingIcon name="arrow-up-right" {...arrow} />
          </Link>
        </div>

        {/* The sections of the landing: from a document they lead back to the landing. */}
        <nav aria-labelledby="footer-product" className={styles.column}>
          <p id="footer-product" className={styles.title}>
            Продукт
          </p>
          <ul className={styles.list} role="list">
            {landingNavigation.map(({ href, label }) => (
              <li key={href}>
                <a href={`/${href}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-labelledby="footer-documents" className={styles.column}>
          <p id="footer-documents" className={styles.title}>
            Документы
          </p>
          <ul className={styles.list} role="list">
            {legalDocuments.map((document) => (
              <li key={document.slug}>
                <Link href={legalDocumentHref(document.slug)}>{document.title}</Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.column}>
          <p className={styles.title}>Контакты</p>
          <address className={styles.contacts}>
            <span>
              {SITE_OPERATOR.name}, {SITE_OPERATOR.status}
            </span>
            <span>ИНН {SITE_OPERATOR.inn}</span>
            <a href={`mailto:${SITE_EMAIL}`}>
              <LandingIcon name="mail" {...contactIcon} />
              {SITE_EMAIL}
            </a>
            <a href={`tel:${SITE_PHONE.tel}`}>
              <LandingIcon name="phone" {...contactIcon} />
              {SITE_PHONE.text}
            </a>
          </address>
        </div>
      </div>

      <div className={styles.bottom}>
        <span>© {new Date().getFullYear()} Радити. Все права защищены.</span>
        <div className={styles.bottomLinks}>
          {/* For the search engines and for whoever looks for a page by its name. */}
          <a href="/sitemap.xml">Карта сайта</a>
          <CookieSettingsButton />
          {/* «#top» scrolls to the top of a page that has no element of that id, as a document. */}
          <a href="#top">
            Вернуться наверх <LandingIcon name="arrow-up" size={16} strokeWidth={1.7} />
          </a>
        </div>
      </div>

      <div className={styles.word} aria-hidden="true">
        радити
        {/* CSS sizes the sign from the word; the number is the fallback of the attribute. */}
        <AnimatedBrandSymbol size={156} />
      </div>
    </footer>
  )
}
