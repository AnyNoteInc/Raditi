import {
  badRequest,
  notImplemented,
  type SiteSourceAdapter,
  type SiteSourceKind,
} from '@repo/domain'

import { ftpSource } from './ftp.ts'
import { sftpSource } from './sftp.ts'

/** What the wizard offers, in its order (owner's decision of 17.10.2026: SSH or FTP). */
export const offeredSourceKinds = ['sftp', 'ftp'] as const satisfies readonly SiteSourceKind[]

/** A lookup table: the transport and the worker index the adapters by kind and never compare one. */
const sources: Record<SiteSourceKind, SiteSourceAdapter | null> = {
  sftp: sftpSource,
  ftp: ftpSource,
  // The contracts know a client repository; its adapter comes with P8.
  git: null,
}

export function siteSource(kind: SiteSourceKind): SiteSourceAdapter {
  if (!Object.hasOwn(sources, kind)) throw badRequest('Unknown site source')
  const adapter = sources[kind]
  if (!adapter) throw notImplemented('git source (P8)')
  return adapter
}
