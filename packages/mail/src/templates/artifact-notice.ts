import { button, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

// The letter of a notice of an artifact (docs/plan/88-artifacts.md, Ар54): what happened, in our
// words, a link to the cabinet, and the way to turn such letters off (149-FZ, art. 10, p. 3).

const subjects: Record<MailData['artifact-notice']['kind'], string> = {
  artifact_shared: 'С вами поделились артефактом',
  artifact_comment: 'Новый комментарий в артефакте',
  artifact_agent_reply: 'Агент ответил на вашу заметку',
  artifact_changed: 'Ваш артефакт изменили',
}

const lines: Record<MailData['artifact-notice']['kind'], string> = {
  artifact_shared: 'Пользователь Радити открыл вам доступ к артефакту.',
  artifact_comment: 'В артефакте, к которому у вас есть доступ, появился новый комментарий.',
  artifact_agent_reply: 'Агент ответил на заметку, которую вы ему отправили.',
  artifact_changed: 'Другой пользователь изменил ваш артефакт.',
}

export function renderArtifactNotice(data: MailData['artifact-notice']): RenderedEmail {
  const subject = subjects[data.kind]
  const line = lines[data.kind]
  const open = 'Открыть в Радити'
  const off = 'Такие письма можно выключить в настройках уведомлений.'
  return {
    subject,
    text: textLayout([greeting(), line, `${open}: ${data.url}`, `${off} ${data.settingsUrl}`]),
    html: layout(
      subject,
      p(greeting()) + p(line) + button(open, data.url) + p(off) + p(data.settingsUrl),
    ),
  }
}
