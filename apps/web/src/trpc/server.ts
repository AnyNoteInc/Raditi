import 'server-only'

import { prisma } from '@repo/db'
import { createCaller } from '@repo/trpc'
import { cache } from 'react'

import { getRequestHeaders, getSession } from '@/lib/session'
import { chatServices } from '@/server/chat-services'
import { paymentShop } from '@/server/payment-shop'
import { siteConnections } from '@/server/site-connections'

/**
 * tRPC caller for Server Components, once per request. It reuses the session the layout has
 * already looked up instead of reading it again.
 */
export const getServerCaller = cache(async () => {
  const headers = await getRequestHeaders()
  const current = await getSession()
  return createCaller({
    prisma,
    headers,
    session: current?.session ?? null,
    user: current?.user ?? null,
    billing: paymentShop(),
    chat: chatServices(),
    siteConnections: siteConnections(),
  })
})
