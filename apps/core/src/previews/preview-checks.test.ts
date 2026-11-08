import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { DbPlan, PreviewExecInput } from '@repo/domain'
import { previewRequest, type PreviewResponse } from '@repo/site-content'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  checkRequest,
  lintChangedFiles,
  pageVerdict,
  phpMessageIn,
  previewBootOf,
  smokeCheck,
  smokePages,
} from './preview-checks.ts'

// The real request, but a test may make one of them fail as the time does: 30 s twice is too long.
vi.mock('@repo/site-content', async (importOriginal) => {
  const actual = await importOriginal<{ previewRequest: typeof previewRequest }>()
  return { ...actual, previewRequest: vi.fn(actual.previewRequest) }
})

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

  describe('a page of a stack that says how its live page looks (Т33)', () => {
    const ready = { header: 'x-raditi-stand', absent: ['No configuration file found'] }
    const answer = (
      status: number,
      body: string,
      headers: Record<string, string> = { 'x-raditi-stand': '1' },
    ): PreviewResponse => ({ status, body: Buffer.from(body, 'utf8'), headers })
    const key = 'a'.repeat(32)
    const verdict = (response: PreviewResponse) => pageVerdict(response, ready, hostname, key)
    const alive = { state: 'alive', redirectsAway: false }

    it('is alive with the header, and dead without it or with a text of a dead site', () => {
      expect(verdict(answer(200, '<html>ok</html>'))).toEqual(alive)
      expect(verdict(answer(200, '<html>ok</html>', {}))).toEqual({ state: 'dead' })
      expect(verdict(answer(200, 'Error: No configuration file found.'))).toEqual({
        state: 'dead',
      })
    })

    it('is alive with a warning and with the words of an error a post may quote', () => {
      expect(verdict(answer(200, '<b>Warning</b>: Undefined index in x.php on line 3'))).toEqual(
        alive,
      )
      expect(verdict(answer(200, '<p>Fatal error: Allowed memory size exhausted</p>'))).toEqual(
        alive,
      )
      // A whole message quoted inside the text of a post: PHP starts its own on a line of its own.
      const quoted =
        '<p>Если вы видите «Fatal error: Uncaught Error: Call to undefined function get_header() ' +
        'in /var/www/html/wp-content/themes/shop/index.php on line 3», отключите тему.</p>'
      expect(verdict(answer(200, quoted))).toEqual(alive)
    })

    it('reads a message of PHP in a page linearly, whatever the page holds', () => {
      const big = (unit: string) => unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length))
      const pages = [
        // The shape that made the regular expression of the contract take minutes.
        { page: big('Fatal error:' + ' in'.repeat(30)), dead: false },
        { page: big('\nFatal error:' + ' in'.repeat(30) + ' on line x'), dead: false },
        // A header near every candidate, and no file in front of any.
        { page: big('\nFatal error: <i on line 1'), dead: false },
        // A header far from every file: each ` on line` is a candidate.
        { page: '\nFatal error:' + 'x'.repeat(9000) + big(' in a on line 1'), dead: false },
        {
          page:
            big('<p>x</p>\n') + '<br />\n<b>Fatal error</b>:  x in <b>/a.php</b> on line <b>3</b>',
          dead: true,
        },
      ]
      for (const { page, dead } of pages) {
        const started = performance.now()
        expect(phpMessageIn(page)).toBe(dead)
        expect(performance.now() - started).toBeLessThan(1000)
      }
    })

    it('finds a message of PHP where the expression of the contract does at a line start', () => {
      // The expression of the contract (docs/plan/62-slices/e0.md, Э0д), held to a line start.
      const contract =
        /(?:^|\n)(?:<b>)?(?:PHP )?(?:Fatal|Parse) error(?:<\/b>)?:[\s\S]{0,8192}? in (?:<b>)?[^\n<]{1,512}?(?:<\/b>)? on line (?:<b>)?\d+/
      // Each slot of a message, with a choice that breaks it among the ones that keep it.
      const slots = [
        ['', 'x', '<p>', '\n', 'Fatal error: in a on line 1'],
        ['\nFatal error:', '\n<b>Fatal error</b>:', '\nPHP Parse error:', 'Fatal error:', ''],
        ['', ' x', '\n', '<', ' in ', 'y'.repeat(8192), 'y'.repeat(8193), 'y'.repeat(9000)],
        [' in ', ' in <b>', ' in', ''],
        ['/a.php', 'x', 'x'.repeat(512), 'x'.repeat(513), '<', '\n', '', ' in /b.php'],
        ['', '</b>', '<'],
        [' on line ', ' on line <b>', ' on line', ' in /c on line '],
        ['3', '', 'x'],
        ['', '\n', ' on line 4', ' in d on line 5'],
      ]
      let seed = 62
      const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648)
      let found = 0
      for (let round = 0; round < 3000; round++) {
        let page = ''
        for (const slot of slots) page += slot[(next() >>> 8) % slot.length]
        const expected = contract.test(page)
        if (expected) found++
        expect(phpMessageIn(page), JSON.stringify(page.slice(0, 200))).toBe(expected)
      }
      // The edges: a file of 512 characters and 8 KiB between the header and ` in `, not one more.
      const file = (length: number) => '/' + 'a'.repeat(length - 1)
      for (const [page, expected] of [
        [`\n<b>Fatal error</b>: x in <b>${file(512)}</b> on line <b>3</b>`, true],
        [`\n<b>Fatal error</b>: x in <b>${file(513)}</b> on line <b>3</b>`, false],
        [`\nFatal error: x in ${file(512)} on line 3`, true],
        [`\nFatal error: x in ${file(513)} on line 3`, false],
        [`\nFatal error:${'y'.repeat(8192)} in /a.php on line 3`, true],
        [`\nFatal error:${'y'.repeat(8193)} in /a.php on line 3`, false],
      ] as const) {
        expect(contract.test(page)).toBe(expected)
        expect(phpMessageIn(page)).toBe(expected)
      }
      // Both outcomes are met often enough to mean something.
      expect(found).toBeGreaterThan(100)
      expect(found).toBeLessThan(2900)
    })

    it('is dead with a message PHP itself printed, plain, in html or over several lines', () => {
      for (const body of [
        '<br />\n<b>Fatal error</b>:  x in <b>/var/www/html/a.php</b> on line <b>3</b><br />',
        'Fatal error: x in /var/www/html/a.php on line 3',
        'Parse error: x in /a.php on line 3',
        'PHP Fatal error:  Uncaught Exception: x in /a.php:3\nStack trace:\n#0 {main}\n' +
          '  thrown in /a.php on line 3',
      ])
        expect(verdict(answer(200, body))).toEqual({ state: 'dead' })
    })

    it('is dead at 5xx, closed at 4xx with the header and dead at 4xx without it', () => {
      expect(verdict(answer(500, ''))).toEqual({ state: 'dead' })
      expect(verdict(answer(403, ''))).toEqual({ state: 'closed' })
      expect(verdict(answer(404, ''))).toEqual({ state: 'closed' })
      expect(verdict(answer(404, '', {}))).toEqual({ state: 'dead' })
    })

    it('reads a redirect without following it: to itself alive, away suspect, nowhere dead', () => {
      const moved = (status: number, location?: string, header = true) =>
        answer(status, '', {
          ...(header ? { 'x-raditi-stand': '1' } : {}),
          ...(location === undefined ? {} : { location }),
        })
      expect(verdict(moved(302, '/login'))).toEqual(alive)
      expect(verdict(moved(302, `http://${hostname}:8090/x`))).toEqual(alive)
      expect(verdict(moved(301, 'https://example.ru/'))).toEqual({
        state: 'alive',
        redirectsAway: true,
      })
      expect(verdict(moved(301))).toEqual({ state: 'dead' })
      expect(verdict(moved(301, 'https://example.ru/', false))).toEqual({ state: 'dead' })
      // An address that does not parse leads nowhere either.
      expect(verdict(moved(301, 'http://['))).toEqual({ state: 'dead' })
    })

    it('is dead below 200, whatever the header says', () => {
      expect(verdict(answer(101, ''))).toEqual({ state: 'dead' })
      expect(verdict(answer(0, ''))).toEqual({ state: 'dead' })
    })

    describe('of a configuration that marks a fatal error of PHP with the key of the check', () => {
      const marked = { ...ready, fatalMark: true as const }
      const of = (response: PreviewResponse, readyOf: typeof ready = marked) =>
        pageVerdict(response, readyOf, hostname, key)
      // A whole message quoted where it starts a line itself: a page of the site cannot tell it
      // from PHP's own one, the key of the request alone can.
      const quote = '<pre>\nFatal error: Uncaught Error in /var/www/html/x.php on line 3</pre>'

      it('reads a message of PHP only by the mark with the key of its own request', () => {
        expect(of(answer(200, quote))).toEqual(alive)
        expect(
          of(answer(200, `<html>ok</html>\n<!-- raditi-fatal:${'b'.repeat(32)} -->\n`)),
        ).toEqual(alive)
        expect(of(answer(200, `<html>ok</html>\n<!-- raditi-fatal:${key} -->\n`))).toEqual({
          state: 'dead',
        })
        expect(of(answer(200, `${quote}\n<!-- raditi-fatal:${key} -->\n`))).toEqual({
          state: 'dead',
        })
        // A stack without the field: the quote is a message of PHP, as before (Э0д).
        expect(of(answer(200, quote), ready)).toEqual({ state: 'dead' })
      })

      it('still reads the header, the status and the texts of a dead site', () => {
        expect(of(answer(200, '<html>ok</html>', {}))).toEqual({ state: 'dead' })
        expect(of(answer(500, quote))).toEqual({ state: 'dead' })
        expect(of(answer(200, 'Error: No configuration file found.'))).toEqual({ state: 'dead' })
      })
    })
  })

  describe('a request of a check', () => {
    it('carries a key of its own: 32 hexadecimal digits, another one each time', () => {
      const one = checkRequest().headers['x-raditi-check']
      const two = checkRequest().headers['x-raditi-check']
      expect(one).toMatch(/^[0-9a-f]{32}$/)
      expect(two).toMatch(/^[0-9a-f]{32}$/)
      expect(two).not.toBe(one)
    })

    it('is a GET of the platform’s user agent, as before', () => {
      expect(checkRequest()).toMatchObject({
        method: 'GET',
        headers: { 'user-agent': 'raditi-preview-check' },
        timeoutMs: 30_000,
        maxResponseBytes: 8 * 1024 * 1024,
      })
    })
  })

  describe('over the entry forwarder of the preview', () => {
    let server: Server
    let port = 0
    let flaky = 0
    const hosts: string[] = []
    beforeAll(async () => {
      server = createServer((request, response) => {
        hosts.push(request.headers.host ?? '')
        if (request.url === '/broken') response.end('<b>Fatal error</b>: Uncaught Error')
        else if (request.url === '/down') response.writeHead(500).end()
        else if (request.url === '/moved') response.writeHead(301, { location: '/' }).end()
        else if (request.url === '/live')
          response.writeHead(200, { 'x-raditi-stand': '1' }).end('<html>ok</html>')
        else if (request.url === '/closed') response.writeHead(403, { 'x-raditi-stand': '1' }).end()
        else if (request.url === '/quoted')
          response
            .writeHead(200, { 'x-raditi-stand': '1' })
            .end('<p>Fatal error: Allowed memory size</p>')
        else if (request.url === '/flaky' && flaky++ === 0) request.socket.destroy()
        else if (request.url === '/flaky')
          response.writeHead(200, { 'x-raditi-stand': '1' }).end('<html>ok</html>')
        else if (request.url === '/marked' || request.url === '/foreign')
          // As the generated configuration marks a fatal error: with the key of the request.
          response
            .writeHead(200, { 'x-raditi-stand': '1' })
            .end(
              `<html>ok</html>\n<!-- raditi-fatal:${
                request.url === '/marked'
                  ? String(request.headers['x-raditi-check'])
                  : 'c'.repeat(32)
              } -->\n`,
            )
        else if (request.url === '/heavy')
          response.writeHead(200, { 'x-raditi-stand': '1' }).end('x'.repeat(9 * 1024 * 1024))
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

    it('with a ready page, fails a page without the header and a closed one', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      const ready = { header: 'x-raditi-stand', absent: [] }
      expect(await smokeCheck({ target, pages: ['/live'], ready }, signal)).toEqual({
        passed: true,
        summary: { pages: 1, failed: 0 },
      })
      expect(await smokeCheck({ target, pages: ['/', '/closed', '/live'], ready }, signal)).toEqual(
        { passed: false, summary: { pages: 3, failed: 2 } },
      )
    })

    it('with a ready page, passes a live page quoting the words of an error; without, fails it', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      const ready = { header: 'x-raditi-stand', absent: [] }
      expect(await smokeCheck({ target, pages: ['/quoted'], ready }, signal)).toEqual({
        passed: true,
        summary: { pages: 1, failed: 0 },
      })
      expect(await smokeCheck({ target, pages: ['/quoted'] }, signal)).toEqual({
        passed: false,
        summary: { pages: 1, failed: 1 },
      })
    })

    it('gives the verdict of a page the key of the request that asked it', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      const ready = { header: 'x-raditi-stand', absent: [], fatalMark: true as const }
      expect(await previewBootOf(target, { healthPath: '/marked', ready }, signal)).toEqual({
        state: 'dead',
      })
      expect(await previewBootOf(target, { healthPath: '/foreign', ready }, signal)).toEqual({
        state: 'alive',
        redirectsAway: false,
      })
      expect(await smokeCheck({ target, pages: ['/marked', '/foreign'], ready }, signal)).toEqual({
        passed: false,
        summary: { pages: 2, failed: 1 },
      })
      // Every request with a key of its own.
      const keys = vi
        .mocked(previewRequest)
        .mock.calls.slice(-3)
        .map(([, input]) => input.headers?.['x-raditi-check'])
      expect(keys.every((value) => /^[0-9a-f]{32}$/.test(value ?? ''))).toBe(true)
      expect(new Set(keys).size).toBe(3)
    })

    it('asks the health page once more when a request failed, and reads the second', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      const ready = { header: 'x-raditi-stand', absent: [] }
      flaky = 0
      expect(await previewBootOf(target, { healthPath: '/flaky', ready }, signal)).toEqual({
        state: 'alive',
        redirectsAway: false,
      })
      expect(flaky).toBe(2)
    })

    it('proves nothing when both requests failed on the size or the time', async () => {
      const target = { upstream: { host: '127.0.0.1', port }, hostname }
      const ready = { header: 'x-raditi-stand', absent: [] }
      expect(await previewBootOf(target, { healthPath: '/heavy', ready }, signal)).toEqual({
        state: 'unproved',
      })
      const request = vi.mocked(previewRequest)
      const before = request.mock.calls.length
      const timedOut = new Error('Preview request timed out')
      request.mockRejectedValueOnce(timedOut).mockRejectedValueOnce(timedOut)
      expect(await previewBootOf(target, { healthPath: '/live', ready }, signal)).toEqual({
        state: 'unproved',
      })
      expect(request.mock.calls.length - before).toBe(2)
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
        method: 'GET',
        path: '/live',
        headers: { 'user-agent': 'raditi-preview-check' },
        timeoutMs: 30_000,
        maxResponseBytes: 8 * 1024 * 1024,
      })
    })
  })
})
