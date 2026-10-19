// What a release writes to a hosting with (docs/plan/53-chat-preview-release.md, Р30, Р31): the
// SFTP and FTP(S) writers of the HostingWriter port, DNS without the hosts file, and an HTTP
// transport to a site that dials only an allowed, pinned address. Used by the `deploy-step`
// command of the orchestrator image; nothing here reads a database, Redis or S3.
import type { DeployMethod, HostingWriter } from '@repo/domain'

import { ftpHostingWriter } from './ftp-writer.ts'
import { sftpHostingWriter } from './sftp-writer.ts'

export {
  createFtpHostingWriter,
  epsvPort,
  ftpHostingWriter,
  pasvPort,
  rawFromTyped,
  type FtpWriterOptions,
} from './ftp-writer.ts'
export { createHostLookup, createLookupWith, type ResolverLike } from './lookup.ts'
export {
  createSftpHostingWriter,
  sftpHostingWriter,
  type SftpWriterOptions,
} from './sftp-writer.ts'
export { createPinnedSiteTransport } from './site-http.ts'
export { keyDerivationAllowed, sshKeyFingerprint } from './ssh.ts'

const writers: Partial<Record<DeployMethod, HostingWriter>> = {
  sftp: sftpHostingWriter as HostingWriter,
  ftp: ftpHostingWriter as HostingWriter,
}

/** The writer of a deploy method; null — the method does not write over a file connection. */
export const hostingWriterOf = (method: DeployMethod): HostingWriter | null =>
  writers[method] ?? null
