import { DomainError, type ChatCommandId, type ChatCommandRefusal } from '@repo/domain'

// Refusals of the procedures of a dialog (docs/plan/53-chat-preview-release.md). The English
// message is for the logs; the client reads the Russian text of the code in errors.ts.

/**
 * Why a new dialog, or a retry of one, is not taken; the text is chosen by it (errors.ts,
 * MESSAGE_FROM_DETAILS). `class_unavailable` — «Попробовать ещё» runs in the class `heavy`, and no
 * enabled model of it has a price in force.
 */
export type TaskNotAcceptedReason = 'site_not_active' | 'not_synthetic' | 'class_unavailable'

export const taskNotAccepted = (reason: TaskNotAcceptedReason) =>
  new DomainError('TASK_NOT_ACCEPTED', `A dialog is not accepted: ${reason}`, 409, { reason })

export const taskTextEmpty = () =>
  new DomainError('TASK_TEXT_EMPTY', 'The request has no visible characters', 400)
export const taskTextTooLong = () =>
  new DomainError('TASK_TEXT_TOO_LONG', 'The request is longer than the feed stores', 400)
/** The text is never repeated in the message. */
export const taskTextHasSecret = () =>
  new DomainError('TASK_TEXT_HAS_SECRET', 'The request looks like a password or a key', 400)
export const taskTextInvalid = () =>
  new DomainError('TASK_TEXT_INVALID', 'The request has characters the feed does not store', 400)

/** The agent is at work: words wait until it finishes or asks. */
export const taskBusy = () => new DomainError('TASK_BUSY', 'The agent is at work', 409)
export const taskFinished = () => new DomainError('TASK_FINISHED', 'The dialog has ended', 409)
export const releaseInProgress = () =>
  new DomainError('RELEASE_IN_PROGRESS', 'A release of the dialog is in work', 409)

/** The credits of the attempt ran out: «Продолжить» first, words would stop at once again. */
export const taskContinueRequired = () =>
  new DomainError('TASK_CONTINUE_REQUIRED', 'The dialog waits for «Продолжить»', 409)
export const taskNothingToContinue = () =>
  new DomainError('TASK_NOTHING_TO_CONTINUE', 'The dialog does not wait for «Продолжить»', 409)
export const taskAttemptsExhausted = () =>
  new DomainError('TASK_ATTEMPTS_EXHAUSTED', 'The dialog has used all of its attempts', 409)
/** «Попробовать ещё»: no failure of the dialog waits for a retry, or not the one pressed on. */
export const taskNothingToRetry = () =>
  new DomainError('TASK_NOTHING_TO_RETRY', 'The dialog has no failure to retry', 409)
/**
 * «Попробовать ещё» refused by the daily limit (D7 of 17.10.2026): the press is not a new task,
 * so its words are those of the retry (`feedRetryText.dailyLimit`), not those of
 * BILLING_DAILY_LIMIT_REACHED, which tell to put the task tomorrow. The details of the refusal
 * are kept for the logs.
 */
export const taskRetryDailyLimit = (details: unknown) =>
  new DomainError(
    'TASK_RETRY_DAILY_LIMIT',
    'The daily limit refused the retry of the dialog',
    409,
    details,
  )

/** A command of the chat the server does not allow now; the text is the one `task.commands` shows. */
export const commandUnavailable = (command: ChatCommandId, refusal: ChatCommandRefusal) =>
  new DomainError('CHAT_COMMAND_UNAVAILABLE', `Command ${command} is refused: ${refusal}`, 409, {
    command,
    refusal,
  })

export const releaseConfirmationInvalid = () =>
  new DomainError('RELEASE_CONFIRMATION_INVALID', 'The release confirmation is not valid', 400)
export const releaseConfirmationExpired = () =>
  new DomainError('RELEASE_CONFIRMATION_EXPIRED', 'The release confirmation has expired', 409)
export const releaseCandidateChanged = () =>
  new DomainError('RELEASE_CANDIDATE_CHANGED', 'The candidate changed after the confirmation', 409)
export const releaseVersionTaken = () =>
  new DomainError('RELEASE_VERSION_TAKEN', 'The version is taken on the site', 409)
/**
 * A plan of more than twenty objects, or one whose description is shortened (docs/plan/53,
 * «Операции БД и миграции»; rule 4): the client says they looked at every change first.
 */
export const releaseReviewRequired = () =>
  new DomainError('RELEASE_REVIEW_REQUIRED', 'The changes of the database were not reviewed', 409)
export const releaseVersionNotOffered = () =>
  new DomainError('RELEASE_VERSION_NOT_OFFERED', 'The version is not among the choices', 409)

export const previewNotReady = () =>
  new DomainError('PREVIEW_NOT_READY', 'The preview is being built', 409)

export const siteEnvNotAllowed = () =>
  new DomainError('SITE_ENV_NOT_ALLOWED', 'Only an owner or an admin changes variables', 403)
export const siteEnvNameInvalid = () =>
  new DomainError('SITE_ENV_NAME_INVALID', 'The name of the variable is not allowed', 400)
export const siteEnvNameReserved = () =>
  new DomainError('SITE_ENV_NAME_RESERVED', 'The name of the variable is reserved', 400)
export const siteEnvValueInvalid = () =>
  new DomainError('SITE_ENV_VALUE_INVALID', 'The value of the variable is not allowed', 400)
export const siteEnvHostsInvalid = () =>
  new DomainError('SITE_ENV_HOSTS_INVALID', 'The hosts of the variable are not allowed', 400)
export const siteEnvConsentRequired = () =>
  new DomainError(
    'SITE_ENV_CONSENT_REQUIRED',
    'The agent gets a variable only with the consent',
    400,
  )
export const siteEnvAgentClosed = () =>
  new DomainError(
    'SITE_ENV_AGENT_CLOSED',
    'Variables are not given to the agent in a workspace of client data before the 152-FZ gate',
    409,
  )
export const siteEnvLimit = () =>
  new DomainError('SITE_ENV_LIMIT', 'The site has the most variables it may have', 409)
export const siteEnvHostsLimit = () =>
  new DomainError(
    'SITE_ENV_HOSTS_LIMIT',
    'The variables of the site would lead to more hosts than a sandbox takes',
    409,
  )
export const siteEnvChanged = () =>
  new DomainError('SITE_ENV_CHANGED', 'The variable was changed meanwhile', 409)
