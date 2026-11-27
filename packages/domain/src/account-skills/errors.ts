import { DomainError } from '../errors.ts'

// The refusals of the skills of an account (docs/plan/97-skills.md). The English message is for
// the logs; the client reads the Russian text of the code — `accountSkillRefusalTexts`, which the
// transport adds to its own table of texts. `details.reason` names what of a skill is wrong, for
// the text of an install that failed; never a byte of the skill.

export type SkillInvalidReason =
  | 'no_skill_md'
  | 'frontmatter'
  | 'name'
  | 'name_folder'
  | 'description'
  | 'description_brackets'
  | 'reserved_name'
  | 'path'
  | 'link'
  | 'too_many_files'
  | 'file_too_large'
  | 'too_large'
  | 'skill_md_too_large'
  | 'secret'
  | 'archive'
  | 'several_skills'

export const skillInvalid = (reason: SkillInvalidReason, path?: string): DomainError =>
  new DomainError('SKILL_INVALID', `The skill is not a valid skill: ${reason}`, 400, {
    reason,
    ...(path ? { path } : {}),
  })

/** Not there, or another account's: never told apart. */
export const skillNotFound = (): DomainError =>
  new DomainError('SKILL_NOT_FOUND', 'No such skill of the account', 404)

export const skillExists = (): DomainError =>
  new DomainError('SKILL_EXISTS', 'The account already has a skill of this name', 409)

export const skillsTooMany = (): DomainError =>
  new DomainError('SKILLS_TOO_MANY', 'The account has as many skills as it may', 409)

export const skillsEnabledTooMany = (): DomainError =>
  new DomainError('SKILLS_ENABLED_TOO_MANY', 'The account has as many skills on as it may', 409)

/** The enabled skills would not fit in one turn together (turnSkillFilesLimits). */
export const skillsTurnTooLarge = (): DomainError =>
  new DomainError('SKILLS_TURN_TOO_LARGE', 'The enabled skills are too large for one turn', 409)

/** A source the platform does not read: a host other than GitHub and GitLab, a bad address. */
export const skillSourceInvalid = (): DomainError =>
  new DomainError('SKILL_SOURCE_INVALID', 'The address is not a repository the platform reads', 400)

/** The repository, its reference or its path is not there or not public. */
export const skillSourceNotFound = (): DomainError =>
  new DomainError('SKILL_SOURCE_NOT_FOUND', 'The repository or its path was not found', 404)

/** The provider did not answer, or limited the platform. */
export const skillSourceUnavailable = (): DomainError =>
  new DomainError('SKILL_SOURCE_UNAVAILABLE', 'The source of the skill does not answer now', 503)

export const marketplaceInvalid = (): DomainError =>
  new DomainError('MARKETPLACE_INVALID', 'The repository has no valid marketplace.json', 400)

export const marketplaceNotFound = (): DomainError =>
  new DomainError('MARKETPLACE_NOT_FOUND', 'No such marketplace of the account', 404)

export const marketplacesTooMany = (): DomainError =>
  new DomainError('MARKETPLACES_TOO_MANY', 'The account has as many marketplaces as it may', 409)

export const skillProposalNotFound = (): DomainError =>
  new DomainError('SKILL_PROPOSAL_NOT_FOUND', 'No such proposal waits for the client', 404)

export const skillProposalsTooMany = (): DomainError =>
  new DomainError('SKILL_PROPOSALS_TOO_MANY', 'Too many proposals wait for the client', 409)

/** Its source has no newer commit, or it is not a skill of a repository. */
export const skillNoUpdate = (): DomainError =>
  new DomainError('SKILL_NO_UPDATE', 'The skill has no update', 409)

const invalidTexts: Readonly<Record<SkillInvalidReason, string>> = Object.freeze({
  no_skill_md: 'в папке навыка нет файла SKILL.md',
  frontmatter: 'в начале SKILL.md нет описания навыка между строками ---',
  name: 'имя навыка — латинские строчные буквы, цифры и дефисы, до 64 знаков',
  name_folder: 'имя навыка в SKILL.md не совпадает с именем его папки',
  description: 'у навыка нет описания или оно длиннее 1024 знаков',
  description_brackets: 'в описании навыка есть угловые скобки < или >',
  reserved_name: 'это имя занято командой чата или встроенным навыком',
  path: 'в навыке есть файл с недопустимым путём',
  link: 'в навыке есть ссылка на другой файл (symlink)',
  too_many_files: 'в навыке больше 100 файлов',
  file_too_large: 'в навыке есть файл больше 5 МБ',
  too_large: 'навык больше 10 МБ',
  skill_md_too_large: 'SKILL.md больше 256 КБ',
  secret: 'похоже, в навыке пароль или ключ',
  archive: 'архив повреждён или это не zip',
  several_skills: 'в архиве несколько навыков — загрузите их по одному',
})

/** The Russian text of a refused skill, its reason included. */
export function skillInvalidText(reason: unknown): string {
  const text =
    typeof reason === 'string' && reason in invalidTexts
      ? invalidTexts[reason as SkillInvalidReason]
      : null
  return text ? `Навык не подходит: ${text}` : 'Навык не подходит'
}

export const accountSkillRefusalTexts: Readonly<Record<string, string>> = Object.freeze({
  SKILL_INVALID: 'Навык не подходит',
  SKILL_NOT_FOUND: 'Навыка нет или он удалён',
  SKILL_EXISTS: 'Навык с таким именем уже установлен',
  SKILLS_TOO_MANY: 'Можно установить до 50 навыков — удалите ненужные',
  SKILLS_ENABLED_TOO_MANY: 'Включить можно до 20 навыков — выключите ненужные',
  SKILLS_TURN_TOO_LARGE: 'Включённые навыки вместе слишком большие — выключите какой-нибудь',
  SKILL_SOURCE_INVALID: 'Нужна ссылка на открытый репозиторий GitHub или GitLab',
  SKILL_SOURCE_NOT_FOUND: 'Репозиторий или папка не найдены — проверьте ссылку',
  SKILL_SOURCE_UNAVAILABLE: 'Источник навыка сейчас не отвечает — попробуйте позже',
  MARKETPLACE_INVALID: 'В репозитории нет каталога навыков (.claude-plugin/marketplace.json)',
  MARKETPLACE_NOT_FOUND: 'Каталога нет или он удалён',
  MARKETPLACES_TOO_MANY: 'Можно добавить до 10 каталогов',
  SKILL_PROPOSAL_NOT_FOUND: 'Предложение уже принято, отклонено или устарело',
  SKILL_PROPOSALS_TOO_MANY: 'Агент предложил слишком много навыков — разберите предложенные',
  SKILL_NO_UPDATE: 'Обновлений нет',
})
