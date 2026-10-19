import { randomBytes } from 'node:crypto'

import {
  HostingGuardError,
  hostingPathProblem,
  temporaryNameOf,
  type HostingPath,
  type HostingWriteOptions,
} from '@repo/domain'

/** The path as the server takes it: the root the server reported plus the segments. */
export function hostingFullPath(root: string, path: HostingPath): string {
  if (hostingPathProblem(path) !== null) throw new HostingGuardError('path')
  return `${root === '/' ? '' : root.replace(/\/+$/, '')}/${path.join('/')}`
}

/** Every proper prefix of the path: the folders an operation passes through, outermost first. */
export function ancestorsOf(path: HostingPath): HostingPath[] {
  if (hostingPathProblem(path) !== null) throw new HostingGuardError('path')
  return path.slice(0, -1).map((_, index) => path.slice(0, index + 1))
}

/** A name for the temporary file of an atomic write: a dot file in the folder of its target. */
export const temporaryName = (random: string): string => temporaryNameOf(random)

/** The temporary name of a write: by its `temporaryKey` — the same on every connection — or random. */
export const temporaryFor = (options: HostingWriteOptions): string =>
  temporaryNameOf(options.temporaryKey ?? randomBytes(12).toString('hex'))
