import { z } from 'zod'

/** Every expected outcome of a connection check. Coarse on purpose: the check must not be a port scanner. */
export const connectionCheckReasons = [
  // Decided without DNS: the literal or the name is not accepted here.
  'address_not_allowed',
  // No such name (in production also: a name that resolves to a non-public address).
  'host_not_found',
  // Refused, filtered, timed out, not this protocol.
  'unreachable',
  // The server does not offer encryption.
  'tls_unavailable',
  // The server refuses a connection without encryption (FTP 534, MySQL «insecure transport»):
  // not a refused login, so it does not count against the endpoint.
  'tls_required',
  // The certificate does not verify for this name.
  'certificate_untrusted',
  // sftp: not the key that was shown, or no key was sent where one is required. The outcome carries
  // the key the server presented now; it is accepted only by an explicit choice of the user.
  'host_key_changed',
  // sftp: a check without a key. Nothing was sent to the server but the key exchange: the outcome
  // carries the key it presented, for the user to compare and confirm before any login.
  'host_key_unknown',
  // Login, password, key or token refused.
  'auth_failed',
  // The private key cannot be read or its passphrase is wrong.
  'key_invalid',
  // Database: the server does not accept connections from our address.
  'host_not_allowed',
  // Signed in, but no right to the folder, the database or its catalog.
  'access_denied',
  // No such folder, database or repository.
  'not_found',
  // The folder holds no site of the chosen platform.
  'not_site_root',
  // git: the token cannot write.
  'no_write_access',
  // Signed in, but a listing or a query could not be completed.
  'transfer_failed',
  // A server feature the platform does not speak.
  'unsupported',
] as const
export type ConnectionCheckReason = (typeof connectionCheckReasons)[number]

/** site_provisioning_stages.error_code. */
export const provisioningErrorCodes = [
  ...connectionCheckReasons,
  // The reference exists, the secret does not (dev OpenBao recreated).
  'access_missing',
  // Row and secret disagree, or the version is not the recorded one.
  'access_mismatch',
  // The reader's guard: the site is not onboarding or the stage is not held.
  'access_refused',
  // A typed secret occurs in more than exactValueFiles files.
  'access_value_common',
  // core has no git, no provisioner token or no gitleaks.
  'repository_not_configured',
  'repository_not_created',
  'repository_push_failed',
  // The remote `main` or the initial tag points at another commit than the one the import
  // recorded: never forced, never retagged.
  'repository_mismatch',
  // Over 100 000 files, 128 MiB, the listing ceilings or a 64 MiB bundle.
  'source_too_large',
  // The server sent more than it listed.
  'source_inconsistent',
  // More than flaggedFiles files with scanner findings.
  'source_has_secrets',
  // Nothing left to import after filtering.
  'source_empty',
  'scan_failed',
  'schema_unreadable',
  // The stage deadline: 60 minutes for code_import, 60 seconds for database_schema.
  'timed_out',
  // The stage went from running back to queued enqueuesPerAttempt times (core stopped or went silent).
  'interrupted',
  // Anything unexpected; the exception itself goes nowhere.
  'internal',
] as const
export type ProvisioningErrorCode = (typeof provisioningErrorCodes)[number]

/** Why an import left an entry out; each is a counter of the stage summary. */
export const importSkipReasons = [
  'excluded',
  'ci',
  'vcs',
  'link',
  'unsupported_path',
  'too_large',
  'secret',
  'nested_site',
  // A folder or a file the server listed but refused to open or no longer has.
  'unreadable',
] as const
export type ImportSkipReason = (typeof importSkipReasons)[number]

/** site_provisioning_stages.summary: counts and flags only, never a path, a host or a message. */
export const provisioningStageSummarySchema = z.strictObject({
  files: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
  skipped: z.partialRecord(z.enum(importSkipReasons), z.number().int().nonnegative()).optional(),
  tables: z.number().int().nonnegative().optional(),
  columns: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  /** code_import while it re-examines an already imported tree after a replaced access. */
  recheck: z.boolean().optional(),
})
export type ProvisioningStageSummary = z.infer<typeof provisioningStageSummarySchema>
