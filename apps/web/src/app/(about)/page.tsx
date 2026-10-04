import type { Metadata } from 'next'
import { Suspense } from 'react'

import { Landing } from '@/components/landing/landing'
import { Pricing } from '@/components/landing/pricing'
import { getLandingPlans } from '@/server/landing-plans'
import { getLandingViewer } from '@/server/landing-viewer'

export const metadata: Metadata = {
  title: 'Напишите в чат — сайт поправим',
  description:
    'Забота о сайте без бесконечной переписки. Посмотрите, как Радити меняет цены, тексты и акции по одному сообщению, и выберите тариф для своего бизнеса.',
}

async function LandingPricing({ isGuest }: { isGuest: boolean }) {
  return (
    <Pricing
      {...await getLandingPlans()}
      actionHref={isGuest ? '/sign-up' : '/projects'}
      actionLabel={isGuest ? 'Создать аккаунт' : 'Открыть проекты'}
    />
  )
}

export default async function HomePage() {
  const viewer = await getLandingViewer()
  return (
    <Landing
      viewer={viewer}
      pricing={
        <Suspense fallback={<p role="status">Загружаем тарифы…</p>}>
          <LandingPricing isGuest={viewer.status === 'guest'} />
        </Suspense>
      }
    />
  )
}
