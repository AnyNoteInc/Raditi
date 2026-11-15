import { DomainError } from '../errors.ts'

// The refusals of the memory (docs/plan/84-projects.md, §4.4). The English message is for the logs
// and the agent; the client reads the Russian text of the code (`memoryRefusalTexts`).

export const memoryTextInvalid = (): DomainError =>
  new DomainError('MEMORY_TEXT_INVALID', 'An entry of memory is 1 to 400 characters', 400)

export const memoryFull = (): DomainError =>
  new DomainError(
    'MEMORY_LIMIT',
    'The memory already has 40 entries: ask the client to delete the ones not needed',
    409,
  )

/** The text is never repeated in the message. */
export const memoryHasSecret = (): DomainError =>
  new DomainError('MEMORY_HAS_SECRET', 'The entry looks like a password or a key', 400)

export const memoryVersionChanged = (): DomainError =>
  new DomainError(
    'MEMORY_VERSION_CHANGED',
    'The entry was changed since you read it: call memory_list again',
    409,
  )

/** Not there, someone else's, or of another memory than the chat's: never told apart. */
export const memoryEntryNotFound = (): DomainError =>
  new DomainError('MEMORY_NOT_FOUND', 'No such entry in the memory of this chat', 404)

export const memoryChangesLimit = (): DomainError =>
  new DomainError(
    'MEMORY_CHANGES_LIMIT',
    'At most 10 changes of memory a turn: keep the rest for the next one',
    409,
  )

/** What the client reads for each refusal above (§4.4), without a final period. */
export const memoryRefusalTexts = Object.freeze({
  MEMORY_TEXT_INVALID: 'Запись — от 1 до 400 знаков',
  MEMORY_LIMIT: 'В памяти уже 40 записей — удалите ненужные',
  MEMORY_HAS_SECRET: 'Похоже, в записи пароль или ключ — уберите его',
  MEMORY_VERSION_CHANGED: 'Запись уже изменили — откройте память снова',
  MEMORY_NOT_FOUND: 'Такой записи в памяти нет',
  MEMORY_CHANGES_LIMIT: 'Агент меняет за один ответ не больше 10 записей памяти',
} satisfies Record<string, string>)
