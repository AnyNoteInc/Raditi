import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { artifactFileUpload, markArtifactFileReady, prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'

import type { ArtifactFileDependencies } from './artifact-file'
import { attachmentUploadDependencies } from './attachment-upload-runtime'
import { chatServices } from './chat-services'

/** The files of artifacts (docs/plan/88-artifacts.md, Ар12): the artifacts bucket. */
export const artifactFileDependencies: ArtifactFileDependencies = {
  appOrigin: attachmentUploadDependencies.appOrigin,
  getSession: getSessionFromHeaders,
  hasRequiredConsents: attachmentUploadDependencies.hasRequiredConsents,
  findUpload: (id, userId) => artifactFileUpload(prisma, { id, userId }),
  markReady: (input) => markArtifactFileReady(prisma, input),
  storage: () => {
    const chat = chatServices()
    if (chat === null) throw new Error('Dialogs are unavailable: their settings do not parse')
    return chat.storage()
  },
  onFailure: throttledLogger((line) => console.error(`[artifact-files] ${line}`)),
}
