import { usageWindowResetText } from '@repo/domain/tasks/client-feed-failures'

import { formatCount } from '@/lib/count'

import type { UsageWindow } from './billing-types'
import { creditsOf } from './plan-format'

// The words of the block «Лимиты» of «Использование» and of the hint of the chat
// (docs/plan/71-usage-limits.md, §4.5): what a window of 5 hours or of the week took, when it
// resets by the Moscow clock, and why there are such limits at all.

/** The one sentence that says why the windows exist. */
export const usageWindowsExplained =
  'Лимиты делят мощность ИИ-агента между клиентами — кредиты от этого не сгорают.'

/** «5 часов», «Неделя». */
export const usageWindowTitle: Readonly<Record<UsageWindow['kind'], string>> = Object.freeze({
  '5h': '5 часов',
  week: 'Неделя',
})

/** «из 20 кредитов» after the count of what the window took. */
export function ofWindowLimit(limit: number): string {
  return `из ${formatCount(limit)} ${creditsOf(limit)}`
}

/** «Сбросится в 18:40», «Сбросится в пн, 10:15», or that the window starts with the first task. */
export function usageWindowNote(window: Pick<UsageWindow, 'kind' | 'resetsAt'>): string {
  if (window.resetsAt === null) return 'Начнётся с первой задачи.'
  return `Сбросится в ${usageWindowResetText(window.kind, window.resetsAt)}.`
}

/** The label of the meter of a window, for a screen reader. */
export function usageWindowMeterLabel(window: UsageWindow & { limit: number }): string {
  return `${usageWindowTitle[window.kind]}: занято ${formatCount(window.used)} ${ofWindowLimit(window.limit)}`
}

/** The share of a window used, 0…1 and beyond; null without a limit. */
export const usageWindowShare = (window: Pick<UsageWindow, 'limit' | 'used'>): number | null =>
  window.limit === null ? null : window.used / window.limit

/** From this share of any window the chat says that the limit is near (Л21). */
export const usageWindowHintShare = 0.8

/**
 * The hint under the field of the chat when a window is taken by 80 % or more: which, how much
 * is left and when it resets; null while no window is that full.
 */
export function usageWindowHint(windows: readonly UsageWindow[]): string | null {
  const full = windows
    .filter((window) => (usageWindowShare(window) ?? 0) >= usageWindowHintShare)
    .sort((a, b) => (usageWindowShare(b) ?? 0) - (usageWindowShare(a) ?? 0))[0]
  if (full === undefined || full.limit === null) return null
  const name = full.kind === '5h' ? 'на 5 часов' : 'на неделю'
  const when =
    full.resetsAt === null ? '' : ` Сброс — в ${usageWindowResetText(full.kind, full.resetsAt)}.`
  if ((full.left ?? 0) === 0) return `Лимит ${name} исчерпан.${when}`
  return `Лимит ${name} почти исчерпан: осталось ${formatCount(full.left ?? 0)} ${ofWindowLimit(full.limit)}.${when}`
}
