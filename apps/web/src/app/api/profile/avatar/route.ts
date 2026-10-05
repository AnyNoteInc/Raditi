import { deleteAvatar, uploadAvatar } from '@/server/avatar'
import { avatarDependencies } from '@/server/avatar-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: Request): Promise<Response> {
  return uploadAvatar(request, avatarDependencies)
}

export function DELETE(request: Request): Promise<Response> {
  return deleteAvatar(request, avatarDependencies)
}
