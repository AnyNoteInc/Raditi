import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { markAttachmentReady, prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'

import type { AttachmentUploadDependencies } from './attachment-upload'
import { admitAttachmentUpload } from './avatar-upload-limit'
import { chatServices } from './chat-services'

const unavailable = () => {
  throw new Error('Dialogs are unavailable: their settings do not parse')
}

export const attachmentUploadDependencies: AttachmentUploadDependencies = {
  appOrigin: () => env.web().appUrl,
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  admitUpload: (userId) => admitAttachmentUpload(prisma, userId),
  async findUpload(id, userId) {
    const row = await prisma.attachment.findFirst({
      where: { id, uploadedById: userId },
      select: {
        id: true,
        s3Key: true,
        contentType: true,
        sizeBytes: true,
        status: true,
        expiresAt: true,
      },
    })
    return row === null
      ? null
      : {
          id: row.id,
          key: row.s3Key,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          status: row.status,
          expiresAt: row.expiresAt,
        }
  },
  markReady: (input) => markAttachmentReady(prisma, input),
  // The inbox client of the dialogs: files belong to dialogs, and where they are not set up
  // nothing could have announced one.
  storage: () => (chatServices() ?? unavailable()).storage(),
  // The cause of a 503 is logged once per operation and minute: a broken bucket cannot flood.
  onFailure: throttledLogger((line) => console.error(`[attachments] ${line}`)),
}
