// The words of «Настройки → Навыки» (docs/plan/97-skills.md, Нв21): Russian, on «вы».

export const accountSkillsText = Object.freeze({
  title: 'Навыки',
  note: 'Навык — папка с инструкциями и программами для типовой задачи: как писать в стиле вашей компании, как собрать отчёт. Включённые навыки агент получает в каждом новом чате и пользуется ими, когда задача подходит. Вызвать навык самому можно командой /имя в чате.',
  counter: (enabled: number, limit: number) => `Включено ${enabled} из ${limit}`,
  enabledFull: (limit: number) =>
    `Включено ${limit} навыков — больше нельзя. Чтобы включить другой, выключите ненужный.`,
  addByLink: 'Добавить по ссылке',
  addFromFile: 'Добавить из файла',
  loading: 'Загружаем навыки',
  loadFailed: 'Не удалось загрузить навыки. Обновите страницу.',

  installed: 'Установленные',
  installedEmpty:
    'Своих навыков пока нет. Установите навык из каталога или попросите агента создать его.',
  platform: 'Радити',
  userOnly: (name: string) => `Только по команде /${name}`,
  updateAvailable: 'Есть обновление',
  switchLabel: (title: string) => `Навык «${title}»`,
  actions: (title: string) => `Действия с навыком «${title}»`,
  open: 'Открыть',
  update: 'Обновить',
  restore: 'Вернуть прошлую версию',
  remove: 'Удалить',

  catalog: 'Каталог Радити',
  catalogNote: 'Навыки, которые подготовили в Радити. Включите нужные.',
  catalogEmpty: 'Все навыки каталога уже включены.',
  enable: 'Включить',

  marketplaces: 'Каталоги навыков',
  marketplacesNote:
    'Открытые каталоги навыков на GitHub и GitLab. Перед установкой проверьте, кто автор навыка.',
  marketplacesFailed: 'Не удалось загрузить каталоги. Попробуйте позже.',
  search: 'Найти навык',
  nothingFound: 'Ничего не нашлось.',
  firstShown: (count: number) => `Показаны первые ${count} — уточните поиск.`,
  stale: 'Каталог сейчас не отвечает — список мог устареть.',
  platformMarketplace: 'каталог платформы',
  install: 'Установить',
  installedMark: 'Установлен',
  removeMarketplace: 'Удалить каталог',
  addMarketplace: 'Добавить каталог',
  marketplaceAddress: 'Адрес репозитория с каталогом',
  marketplaceAddressHelp:
    'Например https://github.com/anthropics/skills — в репозитории должен быть файл .claude-plugin/marketplace.json',
  marketplaceAdded: (name: string) => `Каталог «${name}» добавлен.`,
  marketplaceEmpty: 'В каталоге нет навыков.',
  pluginSkills: (count: number) => `${count} в наборе`,

  /** Нв12: before anything not from the catalog of Радити is installed. */
  warning:
    'Навык — это инструкции и программы, которые агент выполнит в вашей песочнице. Ставьте навыки только из источников, которым доверяете.',
  linkTitle: 'Добавить навык по ссылке',
  linkAddress: 'Ссылка на навык',
  linkHelp:
    'Открытый репозиторий GitHub или GitLab или папка в нём, например https://github.com/anthropics/skills/tree/main/skills/pdf',
  linkEmpty: 'Вставьте ссылку на репозиторий или папку с навыком.',
  fileTitle: 'Добавить навык из файла',
  fileHelp: 'Архив .zip или .skill до 10 МБ, в нём — папка навыка с файлом SKILL.md.',
  chooseFile: 'Выбрать файл',
  fileEmpty: 'Выберите файл навыка.',
  fileTooLarge: 'Файл больше 10 МБ. Навык должен быть меньше.',
  installTitle: (name: string) => `Установить навык «${name}»?`,
  chooseTitle: 'Какой навык установить?',
  chooseNote: 'По этой ссылке несколько навыков. Выберите один.',
  existsTitle: 'Заменить установленный навык новой версией?',
  existsBody: (name: string) =>
    `Навык «${name}» уже установлен. Прошлую версию можно будет вернуть.`,
  replace: 'Заменить',
  cancel: 'Отмена',
  close: 'Закрыть',
  failed: 'Не удалось установить навык. Попробуйте ещё раз.',
  installedNotice: (name: string) =>
    `Навык «${name}» установлен и включён — он появится в новых чатах.`,
  installedOff: (name: string) =>
    `Навык «${name}» установлен, но не включён: включено столько навыков, сколько можно.`,

  viewTitle: (title: string) => `Навык «${title}»`,
  viewFailed: 'Не удалось открыть навык. Попробуйте ещё раз.',
  files: 'Файлы',
  executable: 'программа',
  source: 'Источник',
  version: 'Версия',
  license: 'Лицензия',
  size: 'Размер',
  builtinFiles: 'Встроенный навык Радити: его файлы входят в песочницу.',

  updateTitle: (title: string) => `Обновить навык «${title}»?`,
  updateLoading: 'Смотрим, что изменилось',
  added: 'Добавлены',
  changed: 'Изменены',
  removed: 'Удалены',
  nothingChanged: 'Файлы не изменились.',
  newSkillMd: 'Новый SKILL.md',
  updated: (title: string) => `Навык «${title}» обновлён.`,

  historyTitle: (title: string) => `Прошлые версии «${title}»`,
  historyEmpty: 'Прошлых версий нет.',
  restoreVersion: 'Вернуть',
  restored: (title: string) => `Вернули прошлую версию навыка «${title}».`,

  removeTitle: (title: string) => `Удалить навык «${title}»?`,
  removeBody:
    'Агент перестанет им пользоваться в новых чатах. Вернуть удалённый навык нельзя — только установить заново.',
  keep: 'Не удалять',
  removedNotice: (title: string) => `Навык «${title}» удалён.`,
})
