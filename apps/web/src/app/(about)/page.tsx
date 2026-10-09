import { brandColors } from '@repo/ui/theme/tokens'
import type { Metadata, Viewport } from 'next'
import { Suspense } from 'react'

import { Landing } from '@/components/landing/landing'
import { Pricing } from '@/components/landing/pricing'
import { PricingFallback } from '@/components/landing/pricing-fallback'
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

async function LandingPricing({ isGuest }: { isGuest: boolean }) {
  return (
    <Pricing
      {...await getLandingPlans()}
      actionHref={isGuest ? '/sign-up' : '/projects'}
      actionLabel={isGuest ? 'Зарегистрироваться' : 'Открыть проекты'}
    />
  )
}

export default async function HomePage() {
  const viewer = await getLandingViewer()
  return (
    <Landing
      viewer={viewer}
      pricing={
        <Suspense fallback={<PricingFallback />}>
          <LandingPricing isGuest={viewer.status === 'guest'} />
        </Suspense>
      }
    />
  )
}
