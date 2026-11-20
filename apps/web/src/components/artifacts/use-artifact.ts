'use client'

import { artifactSignalLimits } from '@repo/domain/artifacts'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useEffectEvent, useState } from 'react'

import { useTRPC, useTRPCClient } from '@/trpc/client'

// One artifact on a page (docs/plan/88-artifacts.md, Ар20, §7.4): its blocks, read again on the
// signals of `artifact.signals` (SSE) and, slower, by a poll that stands in for a signal lost on
// the way; who else is here — a mark of presence every 15 s with the block the reader is in, gone
// as the page closes.

export type CabinetArtifact = inferRouterOutputs<AppRouter>['artifact']['read']
export type ArtifactPresence = inferRouterOutputs<AppRouter>['artifact']['presence']

/** The poll while signals come (they say «read now»), and while none do. */
const POLL_SIGNALLED_MS = 20_000
const POLL_UNSIGNALLED_MS = 5_000

export function useArtifact(artifactId: string, { block = null }: { block?: string | null } = {}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [signalled, setSignalled] = useState(false)
  const read = useQuery({
    ...trpc.artifact.read.queryOptions({ artifactId }),
    refetchInterval: signalled ? POLL_SIGNALLED_MS : POLL_UNSIGNALLED_MS,
    refetchIntervalInBackground: false,
  })
  const presence = useQuery({
    ...trpc.artifact.presence.queryOptions({ artifactId }),
    enabled: read.isSuccess,
    refetchInterval: artifactSignalLimits.presenceMarkMs,
  })
  const here = useMutation(trpc.artifact.here.mutationOptions())
  const leave = useMutation(trpc.artifact.leave.mutationOptions())

  useEffect(() => {
    const subscription = client.artifact.signals.subscribe(
      { artifactIds: [artifactId] },
      {
        onData: ({ signal }) => {
          setSignalled(true)
          if (signal !== 'presence')
            void queryClient.invalidateQueries({
              queryKey: trpc.artifact.read.queryKey({ artifactId }),
            })
          if (signal !== 'changes')
            void queryClient.invalidateQueries({
              queryKey: trpc.artifact.presence.queryKey({ artifactId }),
            })
        },
        onError: () => setSignalled(false),
        onComplete: () => setSignalled(false),
      },
    )
    return () => subscription.unsubscribe()
  }, [artifactId, client, queryClient, trpc])

  // The mark of presence: now, on a change of the block, and every 15 s.
  const markHere = useEffectEvent((at: string | null) => here.mutateAsync({ artifactId, block: at }))
  useEffect(() => {
    if (!read.isSuccess) return
    const say = () =>
      void markHere(block)
        .then((people) =>
          queryClient.setQueryData(trpc.artifact.presence.queryKey({ artifactId }), people),
        )
        .catch(() => undefined)
    say()
    const timer = window.setInterval(say, artifactSignalLimits.presenceMarkMs)
    return () => window.clearInterval(timer)
  }, [artifactId, block, read.isSuccess, queryClient, trpc])
  const gone = useEffectEvent(() => leave.mutate({ artifactId }))
  useEffect(() => () => gone(), [artifactId])

  const reread = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.read.queryKey({ artifactId }) })
  return { read, presence: presence.data ?? null, reread }
}
