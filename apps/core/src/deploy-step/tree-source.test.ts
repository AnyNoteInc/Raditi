import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { RunFacts } from './run-facts.ts'
import { createTreeSource, TreeSourceError } from './tree-source.ts'

const run: RunFacts = {
  event: 'push',
  ref: 'refs/tags/v1.4.0',
  refName: 'v1.4.0',
  sha: '3f786850e387550fdab836ed7e6dc881de23001b',
  server: 'https://gitea.example.test',
  repository: 'sites/site-0196abcd',
}
const text = '<?php echo "новая главная";\n'
const expected = {
  sha256: createHash('sha256').update(text).digest('hex'),
  sizeBytes: Buffer.byteLength(text),
}

function gitea(answer: () => Response) {
  const asked: { url: string; headers: Record<string, string>; redirect?: string }[] = []
  const send: typeof fetch = async (input, init) => {
    asked.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      redirect: init?.redirect,
    })
    return answer()
  }
  return { asked, source: createTreeSource({ run, token: 'job-token', fetch: send }) }
}

describe('the files of the release commit (Р30)', () => {
  it('reads a file of its own repository at the run’s commit with the job token', async () => {
    const g = gitea(() => new Response(text))
    const bytes = await g.source.file('wp-content/themes/shop/функции.php', expected)
    expect(Buffer.from(bytes).toString()).toBe(text)
    expect(g.asked).toEqual([
      {
        url: `https://gitea.example.test/api/v1/repos/sites/site-0196abcd/raw/wp-content/themes/shop/${encodeURIComponent('функции.php')}?ref=${run.sha}`,
        headers: { authorization: 'token job-token' },
        redirect: 'error',
      },
    ])
  })

  it('takes only the size and the SHA-256 the manifest names', async () => {
    for (const body of [`${text}x`, text.replace('новая', 'старая'), '']) {
      const g = gitea(() => new Response(body))
      await expect(g.source.file('index.php', expected)).rejects.toBeInstanceOf(TreeSourceError)
    }
    for (const status of [404, 401, 500]) {
      const g = gitea(() => new Response('denied', { status }))
      await expect(g.source.file('index.php', expected)).rejects.toBeInstanceOf(TreeSourceError)
    }
  })

  it('keeps a path of the site a path: `..` and `?` cannot reach another route', async () => {
    const g = gitea(() => new Response(text))
    await g.source.file('a/..%2F..%2Fsecrets?x=1', expected).catch(() => {})
    const url = new URL(g.asked[0]!.url)
    expect(url.pathname.startsWith('/api/v1/repos/sites/site-0196abcd/raw/')).toBe(true)
    expect(url.searchParams.get('ref')).toBe(run.sha)
    expect([...url.searchParams.keys()]).toEqual(['ref'])
  })
})
