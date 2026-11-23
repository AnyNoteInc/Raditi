import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import {
  createCaller,
  createContext,
  canvasThumbFile,
  readArtifactExport,
  readChatImage,
  readTaskFile,
} from '@repo/trpc'

import { chatServices } from './chat-services'
import type { ArtifactExportDependencies } from './artifact-export'
import type { CanvasThumbDependencies } from './canvas-thumb'
import type { TaskFileDependencies } from './task-file'
import type { TaskFileImageDependencies } from './task-file-image'

const unavailable = () => {
  throw new Error('Dialogs are unavailable: their settings do not parse')
}

export const taskFileDependencies: TaskFileDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  read: (input) => readTaskFile(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: throttledLogger((line) => console.error(`[chat] ${line}`)),
}

/** A picture of the chat a text document shows (docs/plan/67-agent-documents.md, Д5). */
export const taskFileImageDependencies: TaskFileImageDependencies = {
  getSession: taskFileDependencies.getSession,
  hasRequiredConsents: taskFileDependencies.hasRequiredConsents,
  read: (input) => readChatImage(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: taskFileDependencies.onFailure,
}

/** A thumbnail of a screen of a canvas (docs/plan/88-artifacts.md, §7.7, slice 88.15). */
export const canvasThumbDependencies: CanvasThumbDependencies = {
  getSession: taskFileDependencies.getSession,
  hasRequiredConsents: taskFileDependencies.hasRequiredConsents,
  read: (input) => canvasThumbFile(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: taskFileDependencies.onFailure,
}

/** «Скачать → Excel» of a table (docs/plan/88-artifacts.md, question 26). */
export const artifactExportDependencies: ArtifactExportDependencies = {
  getSession: taskFileDependencies.getSession,
  hasRequiredConsents: taskFileDependencies.hasRequiredConsents,
  read: (input) => readArtifactExport(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: taskFileDependencies.onFailure,
}
