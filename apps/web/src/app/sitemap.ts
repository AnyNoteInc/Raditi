import { legalDocuments } from '@repo/domain'
import type { MetadataRoute } from 'next'

import { env } from '@/env'
import { legalDocumentHref } from '@/lib/legal'

// The address comes from the environment of the running server, not of the build.
export const dynamic = 'force-dynamic'

/** The public pages: the landing and every legal document, by the date of its edition. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = new URL(env.web().appUrl).origin
  return [
    { url: `${origin}/`, changeFrequency: 'weekly', priority: 1 },
    ...legalDocuments.map((document) => ({
      url: `${origin}${legalDocumentHref(document.slug)}`,
      lastModified: document.version,
      changeFrequency: 'yearly' as const,
      priority: 0.3,
    })),
  ]
}
