import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { DbPlan, PreviewExecInput } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { lintChangedFiles, smokeCheck, smokePages } from './preview-checks.ts'

const signal = new AbortController().signal
const hostname = 'site-0f3a9c1b-chat-a1b2c3.localhost'

describe('the checks of a candidate on its preview', () => {
  it('lints the changed files of the server language in batches, deleted ones aside', async () => {
    const calls: PreviewExecInput[] = []
    const files = [
      ...Array.from({ length: 60 }, (_, i) => ({
        path: `wp-content/themes/shop/f${i}.php`,
        change: 'modified' as const,
        sizeBytes: 1,
        executable: false,
      })),
      {
        path: 'wp-content/themes/shop/style.css',
        change: 'added' as const,
        sizeBytes: 1,
        executable: false,
      },
      {
        path: 'wp-content/themes/shop/gone.php',
        change: 'deleted' as const,
        sizeBytes: 0,
        executable: false,
      },
    ]
    const runtime = {
      async exec(_id: string, input: PreviewExecInput) {
        calls.push(input)
        const failing = input.argv.includes('wp-content/themes/shop/f3.php')
        return {
          code: 0,
          stdout: Buffer.from(failing ? 'wp-content/themes/shop/f3.php\0' : ''),
          stderr: new Uint8Array(),
        }
      },
    }
    const result = await lintChangedFiles(
      { runtime, previewId: 'p', recipe: { runtime: 'php' }, files },
      signal,
    )
    expect(result).toEqual({ passed: false, summary: { files: 60, failed: 1 } })
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.argv.length <= 64)).toBe(true)
    expect(calls.flatMap((call) => call.argv)).not.toContain('wp-content/themes/shop/gone.php')
  })

  it('opens the health page and the pages of the objects of the plan', () => {
    const plan = [
      { objectRef: 'post:42' },
      { objectRef: 'page:7' },
      { objectRef: 'menu:3' },
    ] as unknown as DbPlan
    expect(
      smokePages(
        {
          healthPath: '/',
          content: {
            access: ['a'],
            objects: ['b'],
            pages: { post: '/?p={id}', page: '/?page_id={id}' },
          },
        },
        plan,
      ),
    ).toEqual(['/', '/?p=42', '/?page_id=7'])
  })

  describe('over the entry forwarder of the preview', () => {
    let server: Server
    let port = 0
    const hosts: string[] = []
    beforeAll(async () => {
      server = createServer((request, response) => {
        hosts.push(request.headers.host ?? '')
        if (request.url === '/broken') response.end('<b>Fatal error</b>: Uncaught Error')
        else if (request.url === '/down') response.writeHead(500).end()
        else if (request.url === '/moved') response.writeHead(301, { location: '/' }).end()
        else response.end('<html>ok</html>')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

    it('counts 2xx and 3xx pages without a fatal error, with the preview as the Host', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      expect(await smokeCheck({ target, pages: ['/', '/moved'] }, signal)).toEqual({
        passed: true,
        summary: { pages: 2, failed: 0 },
      })
      expect(await smokeCheck({ target, pages: ['/', '/broken', '/down'] }, signal)).toEqual({
        passed: false,
        summary: { pages: 3, failed: 2 },
      })
      expect(new Set(hosts)).toEqual(new Set([hostname]))
    })
  })
})
