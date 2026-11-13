import { brandColors } from '@repo/ui/theme/tokens'
import type { Metadata, Viewport } from 'next'

import { Landing, questions } from '@/components/landing/landing'
import { landingSchema, schemaJson } from '@/components/landing/landing-schema'
import { Pricing } from '@/components/landing/pricing'
import { env } from '@/env'
import { getLandingPlans } from '@/server/landing-plans'
import { getLandingViewer } from '@/server/landing-viewer'

const TITLE = 'Радити — ИИ-помощник для сайта: напишите в чат, сайт поправим'
const DESCRIPTION =
  'Радити меняет сайт по сообщению в чате: цены, тексты, фото, акции. WordPress, Joomla, OpenCart, MODX, 1С-Битрикс. Подключим бесплатно, 50 кредитов в подарок.'

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    siteName: 'Радити',
    url: '/',
    title: TITLE,
    description: DESCRIPTION,
  },
}

// The landing is light in every theme, so the browser chrome around it takes the colour of its
// paper; the other routes set no theme colour and follow the theme of the visitor.
export const viewport: Viewport = { themeColor: brandColors.paper }

export default async function HomePage() {
  // The plans come with the page, not after it: an anchor of the address stands where the
  // browser put it, and the plans are there without scripts. Neither lookup rejects, and each
  // answers within three seconds; the plans are kept in memory for a minute.
  const [viewer, plans] = await Promise.all([getLandingViewer(), getLandingPlans()])
  const schema = landingSchema({
    origin: new URL(env.web().appUrl).origin,
    description: DESCRIPTION,
    plans: plans.plans,
    questions,
  })
  return (
    <>
      {/* For the search engines: the same facts the page shows, in the words of schema.org. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: schemaJson(schema) }} />
      <Landing
        viewer={viewer}
        pricing={<Pricing {...plans} isGuest={viewer.status === 'guest'} />}
        captchaSiteKey={env.auth().captcha?.clientKey}
      />
    </>
  )
}
