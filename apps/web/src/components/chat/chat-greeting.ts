'use client'

import { useSyncExternalStore } from 'react'

// The greeting of a new chat (owner's request of 09.11.2026: «в зависимости от времени, добавлять
// имя… Доброе утро, {name}! Готовы, когда вы готовы!», the way Claude and Codex greet). One line,
// not two: either the greeting or a phrase of the agent, both in the greeting's type (owner's
// second request of 09.11.2026). The hour is the viewer's own clock, so it is read in the browser
// alone; the server draws the greeting without a time of day, and the page takes its own pick
// right after it opens.

export type DayPart = 'morning' | 'day' | 'evening' | 'night'

/** 5–11 morning, 12–17 day, 18–22 evening, 23–4 night. */
export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'day'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

const salutation: Readonly<Record<DayPart | 'any', string>> = Object.freeze({
  morning: 'Доброе утро',
  day: 'Добрый день',
  evening: 'Добрый вечер',
  night: 'Доброй ночи',
  any: 'Здравствуйте',
})

/** The phrases that may stand in place of the greeting, the same one while the page stays open. */
export const greetingLines = Object.freeze([
  'Готовы, когда вы готовы.',
  'С чего начнём?',
  'Что поменяем на сайте сегодня?',
  'Расскажите, что нужно сделать, — агент возьмётся.',
  'Чем можем помочь?',
] as const)

/** The client's first name as the greeting says it; null — none to say. */
export function greetingName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
  // An address in place of a name is no name to greet.
  return first === '' || first.includes('@') ? null : first
}

/** How many lines a page may open with: the greeting and each phrase. */
export const greetingChoices = greetingLines.length + 1

/**
 * The one line of a new chat: pick 0 — the greeting at a part of the day (`any` — not known yet),
 * any other — a phrase of `greetingLines`.
 */
export function greetingOf(part: DayPart | 'any', name: string | null, pick: number): string {
  const choice = Math.abs(Math.trunc(pick)) % greetingChoices
  if (choice === 0) return name === null ? `${salutation[part]}!` : `${salutation[part]}, ${name}!`
  return greetingLines[choice - 1] ?? greetingLines[0]
}

interface Moment {
  part: DayPart
  pick: number
}

// One reading per page: the snapshot of `useSyncExternalStore` must stay the same object.
let moment: Moment | null = null
function readMoment(): Moment {
  moment ??= {
    part: dayPartOf(new Date().getHours()),
    pick: Math.floor(Math.random() * greetingChoices),
  }
  return moment
}
const noSubscription = () => () => {}

/** The line of this viewer now; on the server — the greeting without a time of day. */
export function useGreeting(name: string | null | undefined): string {
  const now = useSyncExternalStore(noSubscription, readMoment, () => null)
  const who = greetingName(name)
  return now === null ? greetingOf('any', who, 0) : greetingOf(now.part, who, now.pick)
}
