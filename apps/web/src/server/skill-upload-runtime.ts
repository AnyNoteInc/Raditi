import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { installSkillFromArchive } from '@repo/trpc'

import { attachmentUploadDependencies } from './attachment-upload-runtime'
import { admitSkillUpload } from './avatar-upload-limit'
import type { SkillUploadDependencies } from './skill-upload'
import { skillServices } from './skill-services'

/** «Добавить из файла» of the page «Навыки» (docs/plan/97-skills.md, Нв9). */
export const skillUploadDependencies: SkillUploadDependencies = {
  appOrigin: attachmentUploadDependencies.appOrigin,
  getSession: getSessionFromHeaders,
  hasRequiredConsents: attachmentUploadDependencies.hasRequiredConsents,
  admitUpload: (userId) => admitSkillUpload(prisma, userId),
  install(input) {
    const services = skillServices()
    if (services === null) throw new Error('Skills are unavailable: the chat settings do not parse')
    return installSkillFromArchive(prisma, services, input)
  },
  onFailure: throttledLogger((line) => console.error(`[skills] ${line}`)),
}
