import { DomainError } from '../errors.ts'

// The refusals of projects (docs/plan/84-projects.md, §4.4). The English message is for the logs;
// the client reads the Russian text of the code — `projectRefusalTexts`, which the transport adds
// to its own table of texts.

/** Not there, deleted, or someone else's: the three are never told apart (ПР1). */
export const projectNotFound = (): DomainError =>
  new DomainError('PROJECT_NOT_FOUND', 'No such project of the user', 404)

export const projectNameInvalid = (): DomainError =>
  new DomainError('PROJECT_NAME_INVALID', 'The name of the project is empty or too long', 400)

export const projectGoalTooLong = (): DomainError =>
  new DomainError('PROJECT_GOAL_TOO_LONG', 'The goal of the project is too long', 400)

export const projectInstructionsTooLong = (): DomainError =>
  new DomainError(
    'PROJECT_INSTRUCTIONS_TOO_LONG',
    'The instructions of the project are too long',
    400,
  )

/** The text is never repeated in the message. */
export const projectTextHasSecret = (): DomainError =>
  new DomainError('PROJECT_TEXT_HAS_SECRET', 'A text of the project looks like a secret', 400)

/** A new chat does not start in a project in «Архив» (ПР20). */
export const projectArchived = (): DomainError =>
  new DomainError('PROJECT_ARCHIVED', 'The project is archived', 409)

/** «Удалить навсегда» of a project that is not in the trash: «Вернуть» came first (ПР38). */
export const projectNotInTrash = (): DomainError =>
  new DomainError('PROJECT_NOT_IN_TRASH', 'The project is not in the trash', 409)

/** The chat has a branch of the agent in the repository of its project (ПР2). */
export const taskProjectHasBranch = (): DomainError =>
  new DomainError('TASK_PROJECT_HAS_BRANCH', 'The chat has a branch in the project repository', 409)

/** A pass of the chat is queued or runs: its scope is read on every call of the agent (ПР2). */
export const taskProjectBusy = (): DomainError =>
  new DomainError('TASK_PROJECT_BUSY', 'The agent is at work in the chat', 409)

/** What the client reads for each refusal above (§4.4), without a final period. */
export const projectRefusalTexts: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_NOT_FOUND: 'Проекта нет или он удалён',
  PROJECT_NAME_INVALID: 'Назовите проект — до 80 знаков',
  PROJECT_GOAL_TOO_LONG: 'Цель — не длиннее 500 знаков',
  PROJECT_INSTRUCTIONS_TOO_LONG: 'Инструкции — не длиннее 8000 знаков',
  PROJECT_TEXT_HAS_SECRET:
    'Похоже, в тексте пароль или ключ — уберите его: агент получает этот текст в каждом чате',
  PROJECT_ARCHIVED: 'Проект в архиве — верните его, чтобы начать чат',
  PROJECT_NOT_IN_TRASH:
    'Проект уже вернули из корзины — чтобы удалить его навсегда, сначала удалите его снова',
  TASK_PROJECT_HAS_BRANCH:
    'Агент уже работал в этом чате с репозиторием проекта — такой чат не переносится',
  TASK_PROJECT_BUSY: 'Агент сейчас работает в этом чате — перенесите его, когда он ответит',
  // The files of the context (ПР8); the reason and the scope pick finer words where the transport
  // reads its details.
  PROJECT_FILE_REFUSED: 'Этот файл в проект добавить нельзя',
  PROJECT_FILE_NOT_FOUND: 'Файла нет или он удалён',
  PROJECT_FILE_NOT_READY:
    'Файл ещё не загрузился или время на его загрузку истекло — добавьте его снова',
  PROJECT_FILES_TOO_MANY: 'В проекте уже 100 файлов — удалите лишние, чтобы добавить новые',
  PROJECT_SPACE_FULL: 'Места для файлов не хватает',
})
