/** What core reads of a lead to post it (docs/plan/65-landing-platforms-leads.md). */
export interface LeadForMessage {
  id: string
  number: number
  name: string
  phone: string
  email: string
  site: string
  about: string
  consentVersion: string
  createdAt: Date
}

/** callback_data of «Обработано»: 46 bytes of the 64 Telegram allows. */
export const leadDoneData = (leadId: string) => `lead:done:${leadId}`
const DONE_DATA = /^lead:done:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** The lead a press of «Обработано» names; null for any other button. */
export function leadOfDoneData(data: string | undefined): string | null {
  return DONE_DATA.exec(data ?? '')?.[1] ?? null
}

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * The message of a lead in the group, HTML. Every value is escaped; the longest a lead can be
 * (2 000 characters of the description and the limits of the fields) stays under the 4 096 of
 * Telegram.
 */
export function leadMessage(lead: LeadForMessage): string {
  return [
    `<b>Заявка №${lead.number}</b> · главная, ${moscow.format(lead.createdAt)} МСК`,
    '',
    `<b>Имя:</b> ${escapeHtml(lead.name)}`,
    `<b>Телефон:</b> ${escapeHtml(lead.phone)}`,
    `<b>Почта:</b> ${escapeHtml(lead.email)}`,
    `<b>Сайт:</b> ${escapeHtml(lead.site)}`,
    '',
    '<b>Что хочет менять:</b>',
    escapeHtml(lead.about),
    '',
    `Согласие на обработку данных: да, редакция ${escapeHtml(lead.consentVersion)}`,
    'Нажмите «Обработано», когда свяжетесь: сообщение удалится из Telegram.',
  ].join('\n')
}

/** What is left of the message when Telegram does not let the bot delete it: no data. */
export const leadDoneMessage = (number: number) => `Заявка №${number} обработана.`
