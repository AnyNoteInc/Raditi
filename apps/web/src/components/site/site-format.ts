/** What a saved access is for the owner of the site; an unknown kind is still an access. */
const accessLabels: Readonly<Record<string, string>> = {
  ssh: 'SSH',
  ftp: 'SFTP / FTP',
  wp: 'Вход в панель сайта',
  browser: 'Вход через браузер',
  db: 'База данных',
}
export const accessLabel = (kind: string) => accessLabels[kind] ?? 'Доступ'

/** What the platform uses an access for. */
const accessPurposes: Readonly<Record<string, string>> = {
  ssh: 'Копирование файлов и обновление сайта',
  ftp: 'Копирование файлов и обновление сайта',
  wp: 'Правки текстов, цен и фото',
  browser: 'Работа агента в админке сайта',
  db: 'Сведения о базе данных',
}
export const accessPurpose = (kind: string) => accessPurposes[kind] ?? 'Работа с сайтом'

/** The parts an access of a kind is made of: each is saved, none is shown. */
const accessFields: Readonly<Record<string, readonly string[]>> = {
  ssh: ['адрес сервера', 'порт', 'пользователь', 'пароль или ключ', 'папка сайта'],
  ftp: ['адрес сервера', 'порт', 'пользователь', 'пароль', 'папка сайта'],
  wp: ['имя', 'пароль приложения'],
  browser: ['вход в админку'],
  db: ['адрес', 'порт', 'имя базы', 'пользователь', 'пароль'],
}
export const accessFieldsOf = (kind: string) => accessFields[kind] ?? ['данные доступа']
