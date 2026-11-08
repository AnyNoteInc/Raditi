import { describe, expect, it, vi } from 'vitest'

import CabinetPage from './page'

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`)
  }),
}))

vi.mock('next/navigation', () => ({ redirect }))

describe('CabinetPage', () => {
  it('leads the old sign-in links to the chats', () => {
    expect(() => CabinetPage()).toThrow('redirect /chats')
  })
})
