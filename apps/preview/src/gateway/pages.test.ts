import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { gatewayPages } from './pages.ts'

describe('gatewayPages', () => {
  // docs/plan/61-chats-first.md, К26: the source, for the text of a frame lives in a script.
  it('says «чат», never «диалог»', () => {
    expect(readFileSync(new URL('./pages.ts', import.meta.url), 'utf8')).not.toMatch(/диалог/i)
  })

  it('leads from a preview that is not there to the chats of the cabinet', () => {
    const page = gatewayPages.notFound({ appOrigin: 'https://raditi.example' })

    expect(page.status).toBe(404)
    const html = page.body.toString('utf8')
    expect(html).toContain('href="https://raditi.example/chats"')
    expect(html).toContain('Перейти в кабинет')
  })
})
