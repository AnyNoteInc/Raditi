import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { markProjectFileReady, ownedProjectFile, prisma, projectFileUpload } from '@repo/db'
import { throttledLogger } from '@repo/observability'

import { attachmentUploadDependencies } from './attachment-upload-runtime'
import { admitProjectFileUpload } from './avatar-upload-limit'
import type { ProjectFileDependencies } from './project-file'

/** The files of the context of projects (docs/plan/84-projects.md, ПР8): raditi-inbox of the chats. */
export const projectFileDependencies: ProjectFileDependencies = {
  appOrigin: attachmentUploadDependencies.appOrigin,
  getSession: getSessionFromHeaders,
  hasRequiredConsents: attachmentUploadDependencies.hasRequiredConsents,
  admitUpload: (userId) => admitProjectFileUpload(prisma, userId),
  findUpload: (id, userId) => projectFileUpload(prisma, { id, userId }),
  markReady: (input) => markProjectFileReady(prisma, input),
  findDownload: (id, userId) => ownedProjectFile(prisma, { id, userId }),
  storage: attachmentUploadDependencies.storage,
  onFailure: throttledLogger((line) => console.error(`[project-files] ${line}`)),
}
