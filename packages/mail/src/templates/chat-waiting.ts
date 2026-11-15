import { button, greeting, layout, p, textLayout } from './layout.ts'
import type { ChatWaitingKind, MailData, RenderedEmail } from './schemas.ts'

// The letter of a chat that waits for the client (docs/plan/75-chat-input-output.md, ВВ9): what
// happened, in our own words, and a link to the chat. Nothing the client or the agent wrote.

const subjects: Record<ChatWaitingKind, string> = {
  answered: 'Агент ответил в вашем чате',
  question: 'Агент задал вопрос в вашем чате',
  ready: 'Изменения для сайта готовы',
  failed: 'Агент не смог закончить работу',
  limit: 'Работа агента остановилась',
}

const lines: Record<ChatWaitingKind, string> = {
  answered: 'Агент закончил работу и ответил в чате.',
  question: 'Агенту нужен ваш ответ, чтобы продолжить.',
  ready: 'Агент подготовил изменения. Посмотрите их в чате и выпустите на сайт командой /release.',
  failed: 'Работа остановилась из-за сбоя. Напишите в чате «продолжи» — агент попробует снова.',
  limit: 'Кредиты или недельный лимит закончились. Подробности — в чате.',
}

export function renderChatWaiting(data: MailData['chat-waiting']): RenderedEmail {
  const subject = subjects[data.kind]
  const line = lines[data.kind]
  const off = 'Письма о работе агента можно выключить в настройках уведомлений.'
  return {
    subject,
    text: textLayout([greeting(), line, `Открыть чат: ${data.url}`, `${off} ${data.settingsUrl}`]),
    html: layout(
      subject,
      p(greeting()) + p(line) + button('Открыть чат', data.url) + p(off) + p(data.settingsUrl),
    ),
  }
}
