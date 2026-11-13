'use client'

import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'

import { useTRPC } from '@/trpc/client'

import { usageWindowHint } from './usage-windows-format'

/**
 * Under the field of a chat: that a window of 5 hours or of the week is taken by 80 % or more
 * (plan 70, §4.5), with what is left and when it resets. It reads the same answer as the credit
 * ring (`billing.usage`), so it asks the server for nothing more; nothing while it is unknown.
 */
export function UsageWindowHint() {
  const trpc = useTRPC()
  const usage = useQuery(trpc.billing.usage.queryOptions())
  const hint = usage.data ? usageWindowHint(usage.data.windows) : null
  if (hint === null) return null
  return (
    <Typography role="status" variant="body2" color="textSecondary" sx={{ mt: 1, px: 1.5 }}>
      {hint}
    </Typography>
  )
}
