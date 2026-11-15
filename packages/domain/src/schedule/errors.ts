import { DomainError } from '../errors.ts'
import { pluralRu } from '../plural.ts'
import { scheduleLimits } from './limits.ts'
import { isScheduleTooOftenIssue, SCHEDULE_TOO_OFTEN, SCHEDULE_TOO_OFTEN_TEXT } from './triggers.ts'

/**
 * The errors of the scheduled tasks (docs/plan/82-scheduled-tasks.md, §4.1). Their words are the
 * client's — the cabinet shows them as they are — and the agent reads the same words and codes
 * in the results of its tools.
 */

/** Not there, deleted, or another workspace's: the three are never told apart. */
export const scheduleNotFound = (): DomainError =>
  new DomainError('SCHEDULE_NOT_FOUND', 'Задачи уже нет', 404)

/** Only its creator, while an owner or an administrator of its workspace, changes a task (Зп25). */
export const scheduleForbidden = (): DomainError =>
  new DomainError(
    'SCHEDULE_FORBIDDEN',
    'Менять запланированные задачи может владелец или администратор, создавший её',
    403,
  )

/** Enabled tasks of a workspace at their limit (Зп16). */
export const scheduleLimitReached = (
  limit: number = scheduleLimits.activePerWorkspace,
): DomainError =>
  new DomainError(
    'SCHEDULE_LIMIT',
    `Включено ${limit} ${pluralRu(limit, 'задача', 'задачи', 'задач')} — больше нельзя. Приостановите или удалите одну`,
    409,
    { limit },
  )

/** Changes of tasks one turn of the agent reserves, at their limit (Зп31). */
export const scheduleChangeLimitReached = (
  limit: number = scheduleLimits.changesPerTurn,
): DomainError =>
  new DomainError(
    'SCHEDULE_CHANGE_LIMIT',
    `За один ответ можно изменить не больше ${limit} ${pluralRu(limit, 'запланированной задачи', 'запланированных задач', 'запланированных задач')}`,
    409,
    { limit },
  )

/** Runs closer than an hour (Зп11). */
export const scheduleTooOften = (): DomainError =>
  new DomainError(SCHEDULE_TOO_OFTEN, SCHEDULE_TOO_OFTEN_TEXT, 400)

/** A single run in the past (Зп15). */
export const scheduleInPast = (): DomainError =>
  new DomainError('SCHEDULE_IN_PAST', 'Это время уже прошло — выберите другое', 400)

/** The template «Конкуренты» with its placeholder left as it was (Зп9). */
export const scheduleTemplatePlaceholder = (): DomainError =>
  new DomainError('SCHEDULE_TEMPLATE_PLACEHOLDER', 'Впишите адреса сайтов конкурентов', 400)

/**
 * The project of a task was deleted (Зп22): the task stays bound to it until the client moves it
 * to another project or to none, and it is not turned on there.
 */
export const scheduleProjectGone = (): DomainError =>
  new DomainError(
    'SCHEDULE_PROJECT_GONE',
    'Проект этой задачи удалён — выберите другой проект или «Без проекта»',
    409,
  )

/** «Запустить сейчас» while a run of the task goes on (Зп24). */
export const scheduleRunBusy = (): DomainError =>
  new DomainError('SCHEDULE_RUN_BUSY', 'Задача уже выполняется', 409)

/**
 * The error of schedules a schema refused for running too often; null — refused for another
 * reason, which the caller tells in its own words.
 */
export function scheduleErrorOfIssues(
  issues: readonly { code: string; params?: Record<string, unknown> | undefined }[],
): DomainError | null {
  return issues.some(isScheduleTooOftenIssue) ? scheduleTooOften() : null
}
