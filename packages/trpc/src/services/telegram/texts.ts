// What the bot of the chat says (docs/plan/80-telegram.md): Russian, to «вы», without jargon (rule
// 10). Links lead to the cabinet: the preview, `/release`, payment and the browser live there (Т6).

const settings = (appUrl: string) => `${appUrl.replace(/\/+$/, '')}/settings`

export const telegramText = {
  notLinked: (appUrl: string) =>
    'Здравствуйте! Это бот Радити. Чтобы писать агенту отсюда, подключите Telegram в кабинете: ' +
    `«Настройки» → «Telegram» → «Подключить».\n${settings(appUrl)}`,
  linked: (appUrl: string) =>
    'Telegram подключён. Напишите, что сделать, — агент сделает это и ответит здесь. ' +
    'Голосовые, фото и файлы тоже можно.\n\n' +
    '/new — новый чат\n/chats — последние чаты\n/help — что я умею\n/stop — отключить Telegram\n\n' +
    `Страницы, переменные и оплата — в кабинете: ${appUrl.replace(/\/+$/, '')}/chats`,
  linkTaken:
    'Этот Telegram уже подключён к другому аккаунту Радити. Отключите его там командой /stop или в настройках кабинета.',
  linkCodeBad: (appUrl: string) =>
    `Ссылка для подключения устарела или уже использована. Получите новую в кабинете: ${settings(appUrl)}`,
  unlinked: 'Telegram отключён от Радити. Подключить снова можно в настройках кабинета.',
  help: (appUrl: string) =>
    'Напишите, что сделать, — агент сделает это и ответит здесь. Голосовые, фото и файлы тоже можно.\n\n' +
    '/new — новый чат\n/chats — последние чаты\n/stop — отключить Telegram\n\n' +
    `Страницы, переменные и оплата — в кабинете: ${appUrl.replace(/\/+$/, '')}/chats`,
  consents: (appUrl: string) =>
    `Примите обновлённые документы в кабинете, чтобы продолжить: ${appUrl.replace(/\/+$/, '')}/chats`,
  newChat: 'Напишите, что сделать, — начну новый чат.',
  noChats: 'Чатов пока нет. Напишите, что сделать, — начну первый.',
  chooseChat: 'Выберите чат — следующие сообщения пойдут в него.',
  chatChosen: (title: string) => `Пишу в чат «${title}».`,
  untitled: 'Без названия',
  started: 'Принято, агент начал работу. Ответ пришлю сюда.',
  accepted: 'Принято, агент продолжает работу.',
  queued: 'Агент ещё работает. Сообщение в очереди — отправлю его, когда он закончит.',
  stopped: 'Остановил агента.',
  stopButton: 'Остановить',
  openButton: 'Открыть в кабинете',
  continueButton: 'Продолжить',
  pressStale: 'Эта кнопка больше не действует.',
  wordsOnly: 'Пока принимаю только текст. Напишите словами, что сделать.',
  empty: 'Напишите, что сделать.',
  filesOnly: 'Файлы во вложении.',
  heard: (text: string) => `Распознал: «${text}»`,
} as const
