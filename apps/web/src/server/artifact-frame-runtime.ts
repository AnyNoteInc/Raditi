import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'

import type { ArtifactFrameDependencies } from './artifact-frame'
import { chatServices } from './chat-services'
import { pageLog, pagesOfProcess } from './page-runtime'

export const artifactFrameDependencies: ArtifactFrameDependencies = {
  db: () => prisma,
  chat: chatServices,
  pagesHost: () => pagesOfProcess()?.host ?? null,
  getSession: getSessionFromHeaders,
  onFailure: pageLog,
}
