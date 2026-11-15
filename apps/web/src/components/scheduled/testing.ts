import type { ScheduleDetail, ScheduleItem, ScheduleRun } from './schedule-model'

// Answers of `schedule.list` and `schedule.get` for the component tests: the tasks of the kofeinya
// «Крошка». «Now» is Sunday, 15 November 2026, 12:00 in Moscow.

export const NOW = new Date('2026-11-15T09:00:00.000Z')
export const SCHEDULE_ID = '019f2a00-0000-7000-8000-000000000001'
export const SITE_ID = '019f2a00-0000-7000-8000-0000000000a1'
export const CHAT_ID = '019f2a00-0000-7000-8000-0000000000c1'

export function scheduleRun(patch: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: '019f2a00-0000-7000-8000-0000000000e1',
    dueAt: new Date('2026-11-15T06:00:00.000Z'),
    trigger: 'schedule',
    state: { kind: 'done' },
    chat: { id: CHAT_ID, title: 'Проверка сайта' },
    createdAt: new Date('2026-11-15T06:00:00.000Z'),
    startedAt: new Date('2026-11-15T06:00:05.000Z'),
    ...patch,
  }
}

export function scheduleItem(patch: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: SCHEDULE_ID,
    name: 'Проверка сайта',
    instructions: 'Откройте сайт и пройдите главную и важные страницы.',
    effort: 'low',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    timezone: 'Europe/Moscow',
    enabled: true,
    notify: true,
    pausedReason: null,
    lastRefusalReason: null,
    // Monday, 16 November, 9:00 in Moscow.
    nextRunAt: new Date('2026-11-16T06:00:00.000Z'),
    lastRunAt: null,
    createdVia: 'manual',
    templateSlug: null,
    project: { id: SITE_ID, name: 'Кофейня «Крошка»', deleted: false },
    createdAt: new Date('2026-11-10T09:00:00.000Z'),
    updatedAt: new Date('2026-11-10T09:00:00.000Z'),
    lastRun: null,
    ...patch,
  }
}

export function scheduleDetail(
  patch: Partial<ScheduleDetail> = {},
  runs: ScheduleRun[] = [],
): ScheduleDetail {
  return { ...scheduleItem(patch), runs, ...patch }
}

// ---------------------------------------------------------------------------------------------
// The width of a screen in jsdom
// ---------------------------------------------------------------------------------------------

/** The media of a phone and of a wide screen, as MUI writes `down('sm')` and `up('md')`. */
export const PHONE_MEDIA = '(max-width:599.95px)'
export const WIDE_MEDIA = '(min-width:900px)'

/**
 * What the styles in the page say of an element under a media — or outside any, with `null`:
 * jsdom lays nothing out, reads no media query and knows no grid placement, so a test of what a
 * phone or a wide screen shows reads the rules themselves. The declarations of every rule whose
 * selector is a class of the element, joined.
 */
export function mediaStyleOf(element: Element, media: string | null): string {
  const css = [...document.querySelectorAll('style')].map((style) => style.textContent).join('\n')
  // Each `@media …{…}` cut out of the text, with its own body: `.a{…}.b{…}`.
  const blocks: { media: string; body: string }[] = []
  let rest = ''
  let at = 0
  for (const found of css.matchAll(/@media ([^{]+)\{/g)) {
    const start = found.index
    if (start < at) continue
    rest += css.slice(at, start)
    let depth = 1
    let end = start + found[0].length
    while (depth > 0 && end < css.length) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') depth -= 1
      end += 1
    }
    blocks.push({ media: found[1] ?? '', body: css.slice(start + found[0].length, end - 1) })
    at = end
  }
  rest += css.slice(at)
  const bodies =
    media === null ? [rest] : blocks.filter((block) => block.media === media).map((b) => b.body)
  const declarations: string[] = []
  for (const body of bodies)
    for (const rule of body.matchAll(/\.([\w-]+)\{([^}]*)\}/g)) {
      const [, className, text] = rule
      if (className !== undefined && element.classList.contains(className))
        declarations.push(text ?? '')
    }
  return declarations.join(';')
}

/**
 * Makes `useMediaQuery` answer as a phone does: the queries of MUI's `down('sm')` match, the
 * others do not. Undone by `vi.unstubAllGlobals()`.
 */
export function phoneMatchMedia(query: string): MediaQueryList {
  return {
    matches: query.includes('max-width:599.95px'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }
}
