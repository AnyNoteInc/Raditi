import { artifactSharingOpen } from '@repo/domain/artifacts'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'

import { ShareLanding } from '@/components/artifacts/share-landing'
import { env } from '@/env'
import { getSession } from '@/lib/session'
import { SHARE_COOKIE } from '@/server/artifact-share'

import { UiProviders } from '../ui-providers'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: 'Вам открыли доступ',
  robots: { index: false, follow: false },
}

/**
 * The page of a link `/a#<token>` (docs/plan/88-artifacts.md, Ар33; spike 8): outside the cabinet,
 * 200 for any GET and no redirect while the fragment is there — its script reads and erases it.
 * Without the name of the owner or a title until the reader signed in and agreed.
 */
export default async function ShareLinkPage() {
  const open = artifactSharingOpen(env.web().appEnv)
  const signedIn = await getSession().then(
    (session) => session !== null,
    () => false,
  )
  const held = (await cookies()).has(SHARE_COOKIE)
  return (
    <UiProviders>
      <ShareLanding open={open} signedIn={signedIn} held={held} />
    </UiProviders>
  )
}
