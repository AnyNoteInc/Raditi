/** What a saved access is for the owner of the site; an unknown kind is still an access. */
const accessLabels: Readonly<Record<string, string>> = {
  ssh: 'SSH',
  ftp: 'SFTP / FTP',
  wp: 'Вход в панель сайта',
  browser: 'Вход через браузер',
  db: 'База данных',
}
export const accessLabel = (kind: string) => accessLabels[kind] ?? 'Доступ'
