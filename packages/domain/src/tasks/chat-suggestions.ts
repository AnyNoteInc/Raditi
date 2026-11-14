// The ready requests «Новый чат» offers under its greeting (docs/plan/75-chat-input-output.md,
// ВВ24), by what the chat will be able to do: a chat with the files of the site changes them in its
// copy and puts them on the site by `/release`; a chat with the browser on the site works in its
// administration; a chat without a project opens public sites in the browser or just talks. A
// press puts the words into the field — the client changes them and sends; nothing is sent by it.

export type ChatSuggestionWay = 'code' | 'browser' | 'plain'

export const chatSuggestions: Readonly<Record<ChatSuggestionWay, readonly string[]>> =
  Object.freeze({
    code: Object.freeze([
      'Поменяйте телефон в шапке сайта на ',
      'Добавьте на главную блок с отзывами клиентов',
      'Сделайте кнопку «Позвонить» заметнее на телефоне',
      'Проверьте, почему сайт медленно открывается, и предложите, что исправить',
    ]),
    browser: Object.freeze([
      'Опубликуйте новость: ',
      'Поменяйте цены на странице услуг: ',
      'Добавьте фотографии из вложения в галерею',
      'Найдите на сайте устаревшие страницы и перечислите их',
    ]),
    plain: Object.freeze([
      'Напишите текст для страницы «О компании»: ',
      'Сравните цены трёх конкурентов на ',
      'Составьте план публикаций на месяц для сайта ',
      'Проверьте, как выглядит в поиске сайт ',
    ]),
  })

/** The suggestions of a chat by what it will have: the files of a site, the browser, or neither. */
export function chatSuggestionsFor(
  requirements: { repository: boolean; browser: boolean } | null,
): readonly string[] {
  if (requirements?.repository) return chatSuggestions.code
  if (requirements?.browser) return chatSuggestions.browser
  return chatSuggestions.plain
}
