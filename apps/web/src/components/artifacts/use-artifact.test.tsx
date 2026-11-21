// @vitest-environment jsdom
import type { AppRouter } from '@repo/trpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { ReactNode } from 'react'
import superjson from 'superjson'
import { expect, it, vi } from 'vitest'

import { useArtifact } from './use-artifact'

const { transport } = vi.hoisted(() => ({ transport: vi.fn<typeof fetch>() }))

vi.mock('@/trpc/client', () => {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'https://cabinet.test/api/trpc',
        fetch: transport,
        transformer: superjson,
      }),
    ],
  })
  const options = createTRPCOptionsProxy({ client, queryClient: new QueryClient() })
  const signals = { artifact: { signals: { subscribe: () => ({ unsubscribe() {} }) } } }
  return { useTRPC: () => options, useTRPCClient: () => signals }
})

it('discards all snapshots of the denied artifact and keeps unrelated reads', async () => {
  const artifactId = '019f1a21-1800-7f00-8abc-000000000001'
  const otherId = '019f1a21-1800-7f00-8abc-000000000002'
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  const trpc = createTRPCOptionsProxy<AppRouter>({
    client: createTRPCClient<AppRouter>({ links: [] }),
    queryClient: client,
  })
  const read = [...trpc.artifact.read.queryKey({ artifactId })]
  const versions = [1, 2].map((no) => [...trpc.artifact.version.queryKey({ artifactId, no })])
  const publication = [...trpc.pages.artifactPublication.queryKey({ artifactId })]
  const otherVersion = [...trpc.artifact.version.queryKey({ artifactId: otherId, no: 1 })]
  for (const key of [read, ...versions, publication, otherVersion])
    client.setQueryData(key, { text: 'saved' })
  transport.mockRejectedValue(new Error('Connection lost'))

  const { result } = renderHook(() => useArtifact(artifactId), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  act(() => result.current.discardAccess())
  await waitFor(() => expect(result.current.read.isError).toBe(true))
  expect(client.getQueryData(read)).toBeNull()
  for (const key of [...versions, publication]) expect(client.getQueryData(key)).toBeUndefined()
  expect(client.getQueryData(otherVersion)).toEqual({ text: 'saved' })
})
