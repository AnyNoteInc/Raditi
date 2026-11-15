// What the line under the work of the agent says while it works (owner's request of 14.11.2026):
// in place of «Агент работает» and the moving mark, a word of what it is doing, as Claude Code
// shows one — changing as the turn goes on, at the bottom of the work, not over it.

export const workingPhrases: readonly string[] = Object.freeze([
  'Обдумываю',
  'Свожу воедино',
  'Воплощаю',
  'Рассматриваю',
  'Вожусь',
  'Мастерю',
  'Изучаю',
  'Делаю',
  'Утрамбовываю',
  'Запекаю',
  'Шевелю извилинами',
  'Неспешно продвигаюсь',
  'Перемалываю',
  'Забочусь',
  'Исследую глубины',
  'Соображаю',
  'Прикидываю',
  'Колдую',
  'Распутываю',
  'Сопоставляю',
  'Шлифую',
  'Собираю по кусочкам',
  'Вникаю',
  'Взвешиваю',
  'Набрасываю',
  'Прощупываю',
  'Довожу до ума',
  'Раскладываю по полочкам',
  'Настраиваю',
  'Докапываюсь до сути',
])

/** How long one phrase stays, in seconds. */
export const WORKING_PHRASE_SECONDS = 6

/**
 * The phrase of a turn after `seconds` of work: each turn starts on its own phrase and steps on
 * every few seconds, so two turns in a row do not say the same.
 */
export function workingPhraseOf(turn: number, seconds: number): string {
  const count = workingPhrases.length
  const start = (Math.abs(Math.trunc(turn)) * 7) % count
  const step = Math.floor(Math.max(0, seconds) / WORKING_PHRASE_SECONDS)
  return `${workingPhrases[(start + step) % count]}…`
}
