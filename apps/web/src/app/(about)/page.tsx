import { brandColors } from '@repo/ui/theme/tokens'
import type { Metadata, Viewport } from 'next'

import { Landing } from '@/components/landing/landing'
import { Pricing } from '@/components/landing/pricing'
import { getLandingPlans } from '@/server/landing-plans'
import { getLandingViewer } from '@/server/landing-viewer'

export const metadata: Metadata = {
  title: 'Напишите в чат — сайт поправим',
  description:
    'Радити — ИИ-помощник для сайта малого бизнеса. Сервис готовится к запуску: посмотрите на примере, как менять цены, тексты и акции одним сообщением.',
}

// The landing is light in every theme, so the browser chrome around it takes the colour of its
// paper; the other routes set no theme colour and follow the theme of the visitor.
export const viewport: Viewport = { themeColor: brandColors.paper }

export default async function HomePage() {
  // The plans come with the page, not after it: an anchor of the address stands where the
  // browser put it, and the plans are there without scripts. Neither lookup rejects, and each
  // answers within three seconds; the plans are kept in memory for a minute.
  const [viewer, plans] = await Promise.all([getLandingViewer(), getLandingPlans()])
  return (
    <Landing viewer={viewer} pricing={<Pricing {...plans} isGuest={viewer.status === 'guest'} />} />
  )
}
