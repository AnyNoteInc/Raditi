import { greetingName } from './greeting-name.ts'
import { button, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

// The letter of an invitation to an artifact (docs/plan/88-artifacts.md, Ар35): to any address the
// owner typed, with our words only — the inviter's name when it is safe to show, the kind of the
// artifact as a word, no title. It does not say whether the address has an account in Радити.

export function renderArtifactInvite(data: MailData['artifact-invite']): RenderedEmail {
  const name = greetingName(data.inviterName)
  const subject = name ? `${name} приглашает вас в Радити` : 'Вас приглашают в Радити'
  const line = `${name ? `${name} приглашает вас` : 'Вас приглашают'} открыть ${data.kindWord} в Радити. Войдите или зарегистрируйтесь с этим адресом.`
  const after = 'После входа приглашение будет в разделе «Артефакты».'
  const ignore =
    'Если вы не ждали этого письма, просто не отвечайте на него: без входа с этим адресом доступ не откроется.'
  const open = 'Открыть приглашение'
  return {
    subject,
    text: textLayout([greeting(), line, after, `${open}: ${data.url}`, ignore]),
    html: layout(subject, p(greeting()) + p(line) + p(after) + button(open, data.url) + p(ignore)),
  }
}
