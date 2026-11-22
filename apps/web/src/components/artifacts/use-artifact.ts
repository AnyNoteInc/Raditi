'use client'

import { artifactSignalLimits } from '@repo/domain/artifacts'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useEffectEvent, useState } from 'react'

import { useTRPC, useTRPCClient } from '@/trpc/client'

import { privateArtifactQuery } from './artifact-access-error'

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
  const query = trpc.artifact.read.queryOptions({ artifactId })
  const read = useQuery({
    ...privateArtifactQuery(query),
    refetchInterval: signalled ? POLL_SIGNALLED_MS : POLL_UNSIGNALLED_MS,
    refetchIntervalInBackground: false,
  })
  const readable = read.isSuccess && read.data !== null
  const presence = useQuery({
    ...trpc.artifact.presence.queryOptions({ artifactId }),
    enabled: readable,
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
  const markHere = useEffectEvent((at: string | null) =>
    here.mutateAsync({ artifactId, block: at }),
  )
  useEffect(() => {
    if (!readable) return
    const say = () =>
      void markHere(block)
        .then((people) => {
          if (queryClient.getQueryData(trpc.artifact.read.queryKey({ artifactId })) != null)
            queryClient.setQueryData(trpc.artifact.presence.queryKey({ artifactId }), people)
        })
        .catch(() => undefined)
    say()
    const timer = window.setInterval(say, artifactSignalLimits.presenceMarkMs)
    return () => window.clearInterval(timer)
  }, [artifactId, block, readable, queryClient, trpc])
  const gone = useEffectEvent(() => leave.mutate({ artifactId }))
  useEffect(() => () => gone(), [artifactId])

  const reread = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.read.queryKey({ artifactId }) })
    // An edit can finish after the history drawer has already opened.
    void queryClient.invalidateQueries({
      queryKey: trpc.artifact.versions.queryKey({ artifactId }),
    })
    void queryClient.invalidateQueries({ queryKey: trpc.artifact.changes.queryKey({ artifactId }) })
  }
  const accessLost = read.data === null
  const clearRelatedReads = useEffectEvent(() => {
    const readHash = queryClient.getQueryCache().find({ queryKey: query.queryKey })?.queryHash
    const related = trpc.artifact.pathFilter({
      predicate: ({ queryKey, queryHash }) => {
        const details = queryKey.at(-1)
        return (
          queryHash !== readHash &&
          details != null &&
          typeof details === 'object' &&
          'input' in details &&
          details.input != null &&
          typeof details.input === 'object' &&
          'artifactId' in details.input &&
          details.input.artifactId === artifactId
        )
      },
    })
    // Removing a query also cancels it. Old snapshots must not survive a failed refresh.
    queryClient.removeQueries(related)
    queryClient.removeQueries(trpc.pages.artifactPublication.queryFilter({ artifactId }))
  })
  useEffect(() => {
    if (accessLost) clearRelatedReads()
  }, [accessLost, artifactId])
  const discardAccess = () => {
    // A refusal from another artifact procedure is already authoritative. Don't wait for the
    // next read, and don't let a response that was in flight before the refusal restore the data.
    void queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
    queryClient.setQueryData([...query.queryKey], null)
    void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
  }
  return {
    read,
    accessLost,
    presence: presence.data ?? null,
    reread,
    discardAccess,
  }
}
