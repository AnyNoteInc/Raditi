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

/**
 * The cost of the schedules of a task, as the server counts it for the client's personal workspace,
 * where every task is (Зп30, Зп44). In the
 * window it is a quiet line under the schedules; on the page of the task it is the value of the
 * fact «Стоимость», drawn as the other values are.
 */
export function ScheduleCostLine({
  triggers,
  timezone,
  tone = 'quiet',
}: {
  triggers: ScheduleTrigger[]
  timezone: string
  /** `quiet` — a hint, 14 px and secondary; `value` — a value of a fact, 15 px and primary. */
  tone?: 'quiet' | 'value'
}) {
  const trpc = useTRPC()
  const valid = scheduleTriggersSchema.safeParse(triggers).success
  const cost = useQuery({
    ...trpc.schedule.costHint.queryOptions({ triggers, timezone }),
    enabled: valid,
    placeholderData: keepPreviousData,
  })
  if (!valid || cost.data === undefined) return null
  const { text, over } = costText(cost.data)
  const value = tone === 'value'
  return (
    <Box
      data-cost-tone={tone}
      sx={{
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        color: over ? 'warning.main' : value ? 'text.primary' : 'text.secondary',
      }}
    >
      <Typography
        variant="body2"
        sx={{ color: 'inherit', lineHeight: 1.5, ...(value ? { fontSize: 15 } : {}) }}
      >
        {nbsp(text)}
      </Typography>
    </Box>
  )
}
