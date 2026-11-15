import { downloadProjectFile, uploadProjectFile } from '@/server/project-file'
import { projectFileDependencies } from '@/server/project-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The bytes of a file of a project announced by `projectFile.start` (docs/plan/84, ПР8). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return uploadProjectFile(request, await params, projectFileDependencies)
}

/** «Скачать» of a file of the context of a project: only its author (ПР8). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return downloadProjectFile(request, await params, projectFileDependencies)
}
