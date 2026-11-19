import { deleteAvatar, uploadAvatar } from '@/server/avatar'
import { avatarDependencies } from '@/server/avatar-runtime'
import { cabinetOnly } from '@/server/cabinet-only'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = cabinetOnly((request: Request) => uploadAvatar(request, avatarDependencies))

export const DELETE = cabinetOnly((request: Request) => deleteAvatar(request, avatarDependencies))
