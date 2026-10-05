import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { createS3ObjectStorage } from '@repo/storage'
import { createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'

import type { AvatarDependencies } from './avatar'
import { admitAvatarUpload } from './avatar-upload-limit'

let storage: ObjectStorage | undefined

export const avatarDependencies: AvatarDependencies = {
  appOrigin: () => env.web().appUrl,
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  admitUpload: (userId) => admitAvatarUpload(prisma, userId),
  getUserImage: (id) => prisma.user.findUnique({ where: { id }, select: { image: true } }),
  async setUserImage(id, previous, image) {
    // Auth has no cookie cache: the next session read sees this user image immediately.
    const changed = await prisma.user.updateMany({
      where: { id, image: previous },
      data: { image },
    })
    return changed.count === 1
  },
  storage: () => (storage ??= createS3ObjectStorage(env.storage())),
  // The cause of a 503 is logged once per operation and minute: a broken bucket cannot flood.
  onFailure: throttledLogger((line) => console.error(`[avatar] ${line}`)),
}
