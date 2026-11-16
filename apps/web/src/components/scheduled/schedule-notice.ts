import { scheduleRowTexts } from './schedule-texts'

// What an action says on the screen it leads to (docs/plan/82-scheduled-tasks.md, Зп6): the page
// of a task that was deleted is left for «Ваши», which tells «Задача удалена» there. Kept for this
// tab alone, and once; storage may be closed to the page, and nothing is told then.

const KEY = 'raditi-schedule-notice'

const kept = Object.freeze({ deleted: scheduleRowTexts.deleted })

export type KeptScheduleNotice = keyof typeof kept

export function keepScheduleNotice(notice: KeptScheduleNotice) {
  try {
    sessionStorage.setItem(KEY, notice)
  } catch {
    // Nothing to do: the list opens all the same.
  }
}

/** The words of the notice kept for this screen, once; null — none. */
export function takeScheduleNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return notice !== null && Object.hasOwn(kept, notice)
      ? kept[notice as KeptScheduleNotice]
      : null
  } catch {
    return null
  }
}
