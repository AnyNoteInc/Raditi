// The words of the repository of a project (docs/plan/84-projects.md, ПР9, ПР10, §4.8; slice
// 84.17; P-git-connect, P-git-repo-pick, P-context): connecting it, choosing it, the open link
// and its refusal, and its row inside «Контекст».

export const repoText = Object.freeze({
  // P-git-connect
  connectTitle: 'Подключить репозиторий',
  connectLead: (project: string) => `Выберите, где лежит код проекта «${project}».`,
  where: 'Где лежит репозиторий',
  github: 'GitHub',
  githubHint: 'Установите приложение «Радити» в свой GitHub и выберите репозитории',
  gitlabCom: 'GitLab.com',
  gitlabComHint: 'Вход через GitLab',
  ownServer: 'Свой сервер GitLab — по токену',
  signInAgain: 'Войти заново',
  ownServerHint: 'Адрес вашего сервера и токен доступа',
  soon: 'Скоро',
  serverAddress: 'Адрес сервера',
  serverPlaceholder: 'https://git.example.ru',
  token: 'Токен доступа проекта',
  tokenHint:
    'Создайте его в GitLab с правами «api» и «write_repository». Токен хранится в защищённом хранилище и не попадает к агенту.',
  /** The page of the server where a token is made, its rights chosen (ревью P13). */
  tokenHow: 'Как создать токен',
  tokenPage: (host: string) =>
    `https://${host}/-/user_settings/personal_access_tokens?name=${encodeURIComponent('Радити')}&scopes=api,write_repository`,
  tokenAdvice: 'Токен с правом api открывает все ваши проекты — лучше токен одного проекта',
  showToken: 'Показать токен',
  hideToken: 'Скрыть токен',
  can: 'Что сможет Радити',
  canItems: [
    'Читать и менять код в выбранном репозитории',
    'Открывать запросы на слияние',
    'Смотреть сборки и журналы',
    'Менять настройки сборки и принимать в основную ветку — только после вашего подтверждения',
  ],
  ciVariables:
    'Сборка в ветке агента получает переменные сборки, открытые для всех веток. Ключи выкладки сделайте защищёнными — тогда она их не получит',
  yours: 'Ваши подключения',
  cancel: 'Отмена',
  check: 'Проверить и подключить',
  signIn: 'Войти через GitLab',
  installGithub: 'Установить в GitHub',
  addressRequired: 'Укажите адрес сервера',
  tokenRequired: 'Вставьте токен',
  signInFailed: 'Не удалось начать вход в GitLab. Попробуйте ещё раз.',
  // P-git-repo-pick
  pickTitle: 'Выберите репозиторий',
  account: (login: string | null, host: string) => `${login ?? 'Проверяем…'} · ${host}`,
  checking: 'Проверяем подключение…',
  change: 'Сменить',
  refresh: 'Обновить',
  search: 'Поиск по репозиториям',
  listed: (count: number) => `Репозитории, к которым у вас есть доступ · ${count}`,
  none: 'В этом подключении нет репозиториев',
  nothingFound: 'Ничего не нашлось',
  private: 'Закрытый',
  public: 'Открытый',
  branch: 'Основная ветка',
  branchesLoading: 'Загружаем ветки…',
  agentBranches: (main: string) =>
    `Агент работает в своих ветках raditi/…, в ${main} сам не отправляет.`,
  back: 'Назад',
  attach: 'Подключить к проекту',
  chooseOne: 'Выберите репозиторий',
  // The open link (ПР9)
  linkTitle: 'Ссылка на репозиторий',
  linkLead:
    'Открытый репозиторий на GitHub, GitLab.com или вашем сервере GitLab. Агент только читает его.',
  linkField: 'Ссылка',
  linkPlaceholder: 'https://github.com/owner/repo',
  linkAdd: 'Добавить',
  linkRequired: 'Вставьте ссылку на репозиторий',
  connectAfterCreate: 'Подключить GitLab — после создания проекта',
  // The row in «Контекст» (ПР6)
  row: 'Репозиторий',
  byLink: 'по открытой ссылке · только чтение',
  connectedAs: (login: string) => `подключён как ${login}`,
  open: 'Открыть',
  openLabel: (path: string) => `Открыть репозиторий ${path}`,
  detach: 'Отключить',
  detachLabel: (path: string) => `Отключить репозиторий ${path}`,
  retry: 'Обновить',
  secrets: (paths: readonly string[]) =>
    `В репозитории нашлись строки, похожие на пароли или ключи: ${paths.join(', ')}. Эти файлы агент не получит.`,
  connectedNotice: 'GitLab подключён — выберите репозиторий',
  githubSignInFailed: 'Не удалось начать подключение GitHub. Попробуйте ещё раз.',
  outcome: {
    refused: 'Вход в GitLab не завершён. Попробуйте ещё раз.',
    expired: 'Начните подключение из Радити ещё раз.',
    failed: 'GitLab не подтвердил вход. Попробуйте ещё раз немного позже.',
    unavailable: 'Подключить GitLab.com сейчас нельзя.',
    'github-refused':
      'Подключение GitHub не завершено: приложение «Радити» не подтвердилось в ваших установках. Попробуйте ещё раз.',
    'github-failed': 'GitHub не подтвердил вход. Попробуйте ещё раз немного позже.',
    'github-unavailable': 'Подключить GitHub сейчас нельзя.',
    'github-requested':
      'Запрос отправлен владельцу организации в GitHub. Когда он одобрит установку, подключите репозиторий ещё раз.',
  },
  connectionState: {
    checking: 'Проверяем',
    ok: 'Подключено',
    reauth_needed: 'Нужно войти заново',
    refused: 'Не подключено',
    suspended: 'Приостановлено',
  } as Record<string, string>,
})
