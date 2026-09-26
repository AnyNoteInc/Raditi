'use client'

import type { AppRouter } from '@repo/trpc'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { useState, type ReactNode } from 'react'
import superjson from 'superjson'

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
          false: httpBatchLink({ url: TRPC_URL, transformer: superjson }),
        }),
      ],
    }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  )
}
