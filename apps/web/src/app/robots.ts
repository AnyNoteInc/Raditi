import type { MetadataRoute } from 'next'

import { env } from '@/env'

// The address comes from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic'

/**
 * What a search engine may read: the landing and the legal pages. The cabinet, the sign-in pages
 * and the API hold nothing for a search and are closed to it.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = new URL(env.web().appUrl).origin
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/app',
        '/chats',
        '/projects',
        '/profile',
        '/settings',
        '/onboarding',
        '/preview',
        '/sign-in',
        '/sign-up',
        '/reset-password',
        '/verify-email',
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  }
}
