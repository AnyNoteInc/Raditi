import {
  isFileSourceGuardError,
  isSiteConnectionError,
  type ConnectionCheckReason,
  type ProvisioningErrorCode,
} from '@repo/domain'

/**
 * Why an import stopped, as the stage row will say it. `transient`: a hiccup of the client's
 * server, of our Gitea or of Vault that a later run of the same attempt may not meet — the stage
 * goes back to the queue (enqueues + 1) until the attempt has used its enqueues, then fails with
 * this code. Carries no message of anyone: the code is all a log or the row ever gets.
 */
export class ImportFailure extends Error {
  readonly code: ProvisioningErrorCode
  readonly transient: boolean

  constructor(code: ProvisioningErrorCode, transient = false) {
    super(`Site import: ${code}`)
    this.name = 'ImportFailure'
    this.code = code
    this.transient = transient
  }
}

export const isImportFailure = (error: unknown): error is ImportFailure =>
  error instanceof Error && error.name === 'ImportFailure'

/** A refusal no retry of the attempt cures. */
export const refuse = (code: ProvisioningErrorCode) => new ImportFailure(code)
/** A hiccup: the attempt runs again later. */
export const hiccup = (code: ProvisioningErrorCode) => new ImportFailure(code, true)

/**
 * The stage is no longer held by this run: another worker took it over (the sweep found it
 * silent) or it left `running`. Nothing of the run may be written any more.
 */
export class LeaseLost extends Error {
  constructor() {
    super('Site import lease lost')
    this.name = 'LeaseLost'
  }
}

export const isLeaseLost = (error: unknown): error is LeaseLost =>
  error instanceof Error && error.name === 'LeaseLost'

/** Connection reasons another run may not meet; the others are the server's answer. */
const transientReasons: ReadonlySet<ConnectionCheckReason> = new Set([
  'unreachable',
  'transfer_failed',
])

export const connectionFailure = (reason: ConnectionCheckReason): ImportFailure =>
  transientReasons.has(reason) ? hiccup(reason) : refuse(reason)

/**
 * An error of an open file session or of the walk as the stage says it: a reason of the
 * adapter, a guard of the session, or our own refusal. Anything else is `internal`.
 */
export function sessionFailure(error: unknown): ImportFailure {
  if (isImportFailure(error)) return error
  if (isSiteConnectionError(error)) return connectionFailure(error.reason)
  if (isFileSourceGuardError(error))
    return refuse(error.guard === 'bytes' ? 'source_inconsistent' : 'source_too_large')
  return refuse('internal')
}
