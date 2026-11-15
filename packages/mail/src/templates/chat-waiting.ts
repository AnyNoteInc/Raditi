import { button, greeting, layout, p, textLayout } from './layout.ts'
import {
  scheduledTaskLetterKinds,
  type ChatWaitingKind,
  type MailData,
  type RenderedEmail,
} from './schemas.ts'

// The letter of a chat that waits for the client (docs/plan/75-chat-input-output.md, ВВ9): what
// happened, in our own words, and a link to the chat. Nothing the client or the agent wrote.
// A letter of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп38, Зп39) says it is one and
// names no task: the name of a task is the client's words. A notice of the task itself — it did
// not start, it paused, it missed a run — links to the page of the task.

type ChatKind = Exclude<ChatWaitingKind, (typeof scheduledTaskLetterKinds)[number]>

const subjects: Record<ChatKind, string> = {
  answered: 'Агент ответил в вашем чате',
  question: 'Агент задал вопрос в вашем чате',
  ready: 'Агент закончил работу в вашем чате',
  failed: 'Агент не смог закончить работу',
  limit: 'Работа агента остановилась',
}

const lines: Record<ChatKind, string> = {
  answered: 'Агент закончил работу и ответил в чате.',
  question: 'Агенту нужен ваш ответ, чтобы продолжить.',
  ready: 'Агент закончил работу. Посмотрите результат в чате.',
  failed: 'Работа остановилась из-за сбоя. Напишите в чате «продолжи» — агент попробует снова.',
  limit: 'Кредиты или недельный лимит закончились. Подробности — в чате.',
}

const scheduledSubjects: Record<ChatWaitingKind, string> = {
  answered: 'Запланированная задача выполнена',
  question: 'Запланированной задаче нужен ваш ответ',
  // No pass brings changes any more (docs/plan/83-remove-projects.md, БП2; Зп62).
  ready: 'Запланированная задача выполнена',
  failed: 'Запланированная задача не выполнена',
  limit: 'Запланированная задача остановилась',
  not_started: 'Запланированная задача не запустилась',
  paused: 'Запланированная задача приостановлена',
  missed: 'Запланированная задача пропустила запуск',
}

const scheduledLines: Record<ChatWaitingKind, string> = {
  answered: 'Агент выполнил запланированную задачу и ответил в чате запуска.',
  question: 'Агенту нужен ваш ответ, чтобы продолжить запланированную задачу.',
  ready: 'Агент выполнил запланированную задачу и ответил в чате запуска.',
  failed:
    'Запланированная задача остановилась из-за сбоя. Напишите в чате запуска «продолжи» — агент попробует снова.',
  limit: 'Кредиты или недельный лимит закончились. Подробности — в чате запуска.',
  not_started: 'Запланированная задача не запустилась. Причина — на странице задачи.',
  paused:
    'Запланированная задача приостановлена и сама больше не запускается. Причина — на странице задачи.',
  missed: 'Запланированная задача пропустила запуск. Подробности — на странице задачи.',
}

/** A notice of a scheduled task itself: it has no chat, the letter opens the task. */
const ofTask = (kind: ChatWaitingKind): boolean =>
  (scheduledTaskLetterKinds as readonly string[]).includes(kind)

export function renderChatWaiting(data: MailData['chat-waiting']): RenderedEmail {
  const task = ofTask(data.kind)
  const scheduled = task || data.scheduled === true
  const subject = scheduled ? scheduledSubjects[data.kind] : subjects[data.kind as ChatKind]
  const line = scheduled ? scheduledLines[data.kind] : lines[data.kind as ChatKind]
  const open = task ? 'Открыть задачу' : 'Открыть чат'
  const off = 'Письма о работе агента можно выключить в настройках уведомлений.'
  return {
    subject,
    text: textLayout([greeting(), line, `${open}: ${data.url}`, `${off} ${data.settingsUrl}`]),
    html: layout(
      subject,
      p(greeting()) + p(line) + button(open, data.url) + p(off) + p(data.settingsUrl),
    ),
  }
}
