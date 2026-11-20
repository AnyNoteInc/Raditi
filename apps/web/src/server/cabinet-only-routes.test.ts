import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The routes proxy.ts leaves out (its `config.matcher`): they must answer the domain of pages
// themselves, every method they export, before anything of theirs runs (docs/plan/67, Д3).
const reached = vi.fn(async () => Response.json({ reached: true }))
vi.mock('@/server/attachment-upload', () => ({ uploadAttachment: reached }))
vi.mock('@/server/attachment-upload-runtime', () => ({ attachmentUploadDependencies: {} }))
vi.mock('@/server/project-file', () => ({
  uploadProjectFile: reached,
  downloadProjectFile: reached,
}))
vi.mock('@/server/project-file-runtime', () => ({ projectFileDependencies: {} }))
vi.mock('@/server/avatar', () => ({ uploadAvatar: reached, deleteAvatar: reached }))
vi.mock('@/server/avatar-runtime', () => ({ avatarDependencies: {} }))
vi.mock('@/server/speech', () => ({ recognizeSpeech: reached }))
vi.mock('@/server/speech-runtime', () => ({ speechDependencies: {} }))

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>

const routes: [string, () => Promise<Record<string, unknown>>, string[]][] = [
  ['/api/attachments/1', () => import('@/app/api/attachments/[id]/route'), ['PUT']],
  ['/api/project-files/1', () => import('@/app/api/project-files/[id]/route'), ['PUT', 'GET']],
  ['/api/profile/avatar', () => import('@/app/api/profile/avatar/route'), ['POST', 'DELETE']],
  ['/api/speech', () => import('@/app/api/speech/route'), ['POST']],
]

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'production')
  vi.stubEnv('APP_URL', 'https://raditi.ru')
  vi.stubEnv('PAGES_BASE_DOMAIN', 'pages.raditi.ru')
  reached.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe.each(routes)('%s', (path, load, declared) => {
  const call = async (method: string, host: string) => {
    const handler = (await load())[method] as Handler
    const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(4)
    return handler(new Request(`https://${host}${path}`, { method, headers: { host }, body }), {
      params: Promise.resolve({ id: '1' }),
    })
  }

  it('exports just the methods it is known for', async () => {
    const exported = await load()
    expect(METHODS.filter((method) => method in exported).sort()).toEqual([...declared].sort())
  })

  it('answers the domain of pages 404 on every method, reaching nothing', async () => {
    for (const method of declared) {
      const response = await call(method, 'pages.raditi.ru')
      expect(response.status, method).toBe(404)
      expect(response.headers.get('set-cookie'), method).toBeNull()
    }
    expect(reached).not.toHaveBeenCalled()
  })

  it('reaches the route on the cabinet host', async () => {
    for (const method of declared) expect((await call(method, 'raditi.ru')).status).toBe(200)
    expect(reached).toHaveBeenCalledTimes(declared.length)
  })
})
