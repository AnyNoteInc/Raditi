import { getAvatar } from '@/server/avatar'
import { avatarDependencies } from '@/server/avatar-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string; filename: string }> },
): Promise<Response> {
  return getAvatar(request, await params, avatarDependencies)
}
