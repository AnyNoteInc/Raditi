'use client'

import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'
import { skipToken, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'

import { sectionHeading } from './billing-surface'
import { domainCodeOf, type BillingCallError } from './error-text'

// What the pages ЮKassa sends the customer back to share: how they keep asking the server about
// what the customer came back from, and how they show its outcome.

/** The pause between two looks at something that has no outcome yet. */
export const RETURN_POLL_MS = 3_000
/** How long a return page keeps looking by itself; after that the customer asks. */
export const RETURN_WAIT_MS = 30_000

/**
 * A failed look that looking again can cure: the request did not reach the server, or the
 * server could not answer. A refusal has a code of its own and stays a refusal.
 */
export const transient = (error: BillingCallError | null) =>
  error !== null && domainCodeOf(error) === null

/**
 * Asks about what the customer came back from, at once and then every few seconds while it has
 * no outcome: the notification of ЮKassa may be late or lost, and asking is what settles it
 * then. The server's procedure is a mutation read as a query: looking settles, and looking
 * again is safe. The query gives the polling, one request at a time and none after leaving. A
 * look that did not get through is asked again like any other; `failed` reports it once the
 * page has stopped asking by itself.
 */
export function useReturnCheck<Answer>({
  queryKey,
  ask,
  unsettled,
}: {
  queryKey: readonly unknown[]
  /** null: there is nothing to ask about, and nothing is asked. */
  ask: (() => Promise<Answer>) | null
  /** The answer has no outcome yet: looking again may bring one. */
  unsettled: (answer: Answer) => boolean
}) {
  const [waitedOut, setWaitedOut] = useState(false)
  /** Looking again may bring news: there is no outcome yet, or the last look was lost. */
  const worthAsking = (state: { data: Answer | undefined; error: BillingCallError | null }) =>
    state.error ? transient(state.error) : state.data !== undefined && unsettled(state.data)

  const check = useQuery({
    queryKey,
    queryFn: ask ?? skipToken,
    refetchInterval: ({ state }) => (!waitedOut && worthAsking(state) ? RETURN_POLL_MS : false),
    // A customer who comes back to the tab sees things as they are now.
    refetchOnWindowFocus: ({ state }) => (worthAsking(state) ? 'always' : false),
    refetchOnReconnect: false,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })

  const asks = ask !== null
  useEffect(() => {
    if (!asks) return
    const timer = window.setTimeout(() => setWaitedOut(true), RETURN_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [asks])

  return {
    check,
    waitedOut,
    // While the page still asks by itself, a look that was merely lost is not a failure yet.
    failed: check.isError && (waitedOut || !transient(check.error)),
  }
}

/** One outcome of a return page: a sign, a title, what it means and where to go next. */
export function Outcome({
  icon,
  tone = 'text.secondary',
  title,
  children,
  actions,
}: {
  icon: AppIconName | 'progress'
  tone?: 'success.main' | 'error.main' | 'text.secondary'
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
      <Box sx={{ display: 'flex', flexShrink: 0, mt: '1px', color: tone }}>
        {icon === 'progress' ? (
          <CircularProgress size={24} color="inherit" aria-hidden="true" />
        ) : (
          <AppIcon name={icon} size={24} />
        )}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography component="h2" sx={sectionHeading}>
          {title}
        </Typography>
        <Box sx={{ maxWidth: '62ch', mt: 1, '& > p + p': { mt: 1 } }}>{children}</Box>
        {actions ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2.5 }}>{actions}</Box>
        ) : null}
      </Box>
    </Box>
  )
}
