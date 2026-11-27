import { cabinetOnly } from '@/server/cabinet-only'
import { uploadSkill } from '@/server/skill-upload'
import { skillUploadDependencies } from '@/server/skill-upload-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Добавить из файла» of the page «Навыки»: a `.zip` or `.skill` (docs/plan/97-skills.md, Нв9). */
export const POST = cabinetOnly((request: Request) => uploadSkill(request, skillUploadDependencies))
