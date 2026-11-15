'use client'

import { scheduleTriggersSchema, type ScheduleTrigger } from '@repo/domain/schedule'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import type { ScheduleCost } from './schedule-model'
import { scheduleCostTexts } from './schedule-texts'

/**
 * «Каждый запуск тратит кредиты, как обычный чат, — в среднем около 11. Так выйдет примерно N в
 * неделю; ваш недельный лимит — M.» (Зп30); more than half the limit — in the colour of a
 * warning, with «Остальным чатам останется меньше»; only by hand — the first sentence alone.
 */
export function costText(cost: ScheduleCost): { text: string; over: boolean } {
  const each = scheduleCostTexts.each(cost.averageCredits)
  if (cost.runsPerWeek === 0) return { text: each, over: false }
  const week = scheduleCostTexts.week(cost.creditsPerWeek)
  const limit = cost.weeklyLimit === null ? '.' : scheduleCostTexts.limit(cost.weeklyLimit)
  return {
    text: `${each} ${week}${limit}${cost.overHalf ? ` ${scheduleCostTexts.over}` : ''}`,
    over: cost.overHalf,
  }
}

/** The cost of the schedules of a task, as the server counts it for its workspace (Зп30). */
export function ScheduleCostLine({
  siteId,
  triggers,
  timezone,
}: {
  siteId: string | null
  triggers: ScheduleTrigger[]
  timezone: string
}) {
  const trpc = useTRPC()
  const valid = scheduleTriggersSchema.safeParse(triggers).success
  const cost = useQuery({
    ...trpc.schedule.costHint.queryOptions({ siteId, triggers, timezone }),
    enabled: valid,
    placeholderData: keepPreviousData,
  })
  if (!valid || cost.data === undefined) return null
  const { text, over } = costText(cost.data)
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        color: over ? 'warning.main' : 'text.secondary',
      }}
    >
      <Typography variant="body2" sx={{ color: 'inherit', lineHeight: 1.5 }}>
        {nbsp(text)}
      </Typography>
    </Box>
  )
}
