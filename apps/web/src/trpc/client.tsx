'use client'

import type { AppRouter } from '@repo/trpc'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { useEffect, useState, type ReactNode } from 'react'
import superjson from 'superjson'

import { cabinetSessionChannel } from '@/lib/cabinet-session-signal'

import { MAX_BATCH_SIZE } from './batch'
import { consentRedirectLink } from './consent-redirect'
import { getQueryClient } from './query-client'

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

// Same origin: the browser sends the session cookie with every call.
const TRPC_URL = '/api/trpc'

/** `userId`: the signed-in user; the browser cache is never shared between accounts. */
export function TRPCReactProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const queryClient = getQueryClient(userId)
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        consentRedirectLink(),
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: httpSubscriptionLink({ url: TRPC_URL, transformer: superjson }),
          false: splitLink({
            // Private note writes must be independently abortable.
            condition: (op) =>
              op.type === 'mutation' &&
              (op.path === 'artifact.addCommentReply' || op.path === 'artifact.dispatchComments'),
            true: httpLink({ url: TRPC_URL, transformer: superjson }),
            false: httpBatchLink({
              url: TRPC_URL,
              transformer: superjson,
              maxItems: MAX_BATCH_SIZE,
            }),
          }),
        }),
      ],
    }),
  )

  const [discardedUser, setDiscardedUser] = useState<string | null>(null)
  useEffect(() => {
    const channel = cabinetSessionChannel()
    if (channel === null) return
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data !== null && (typeof data !== 'string' || data === userId)) return
      queryClient.clear()
      setDiscardedUser(userId)
    }
    channel.postMessage(userId)
    return () => channel.close()
  }, [queryClient, userId])

  if (discardedUser === userId)
    return (
      <main>
        <p>Вход изменился. Откройте кабинет заново.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Открыть кабинет
        </button>
      </main>
    )

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
