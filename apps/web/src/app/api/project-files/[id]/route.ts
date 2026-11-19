import { cabinetOnly } from '@/server/cabinet-only'
import { downloadProjectFile, uploadProjectFile } from '@/server/project-file'
import { projectFileDependencies } from '@/server/project-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The bytes of a file of a project announced by `projectFile.start` (docs/plan/84, ПР8). */
export const PUT = cabinetOnly(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
    uploadProjectFile(request, await params, projectFileDependencies),
)

/** «Скачать» of a file of the context of a project: only its author (ПР8). */
export const GET = cabinetOnly(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
    downloadProjectFile(request, await params, projectFileDependencies),
)
