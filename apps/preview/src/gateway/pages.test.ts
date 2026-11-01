import { describe, expect, it } from 'vitest'

import { gatewayPages } from './pages.ts'

describe('gatewayPages', () => {
  it('leads from a preview that is not there to the chats of the cabinet', () => {
    const page = gatewayPages.notFound({ appOrigin: 'https://raditi.example' })

    expect(page.status).toBe(404)
    const html = page.body.toString('utf8')
    expect(html).toContain('href="https://raditi.example/chats"')
    expect(html).toContain('Перейти в кабинет')
  })
})
