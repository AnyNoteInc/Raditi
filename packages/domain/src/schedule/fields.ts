import { z } from 'zod'

import { hasVisibleText } from '../tasks/client-feed-text.ts'
import { scheduleLimits } from './limits.ts'

/**
 * The words of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп26): its name — one line —
 * and its instructions — what the agent gets as the client's message of each run. The form
 * only: whether the instructions look like a password or a key is asked by the writers
 * (`looksLikeSecret`, «Похоже, в инструкции пароль или ключ — уберите его»), so that the client
 * and the agent hear why.
 */

/** A name: one line of text, as written, without spaces around it. */
export const scheduleNameSchema = z
  .string()
  .min(1)
  .max(scheduleLimits.nameMax)
  .refine(
    (text) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) && text.trim() === text,
    'one line of text without spaces around it',
  )
  .refine(hasVisibleText, 'the name has no visible characters')

// Line feeds and tabs are words of the client; any other control character is not.
const forbiddenInInstructions = /[^\P{Cc}\n\t]/u

/** The instructions: the words of a request of the chat, as `feed.request` stores them. */
export const scheduleInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  // Aborts: the checks below are not run on a text of any length.
  .max(scheduleLimits.instructionsMax, { abort: true })
  .refine((text) => !forbiddenInInstructions.test(text), 'control characters are not allowed')
  // Half of a surrogate pair: jsonb would refuse it.
  .refine((text) => text.isWellFormed(), 'ill-formed text is not allowed')
  .refine(hasVisibleText, 'the instructions have no visible characters')

/** Where a task was set up: the window, a template of §4.6, or a chat with the agent (Зп9, Зп33). */
export const scheduleCreatedVia = ['manual', 'template', 'chat'] as const
export type ScheduleCreatedVia = (typeof scheduleCreatedVia)[number]
