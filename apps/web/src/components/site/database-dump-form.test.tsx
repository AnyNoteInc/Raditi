// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SITE_ID } from '@/components/chat/testing'

import { DatabaseDumpForm, dumpText, type DumpView } from './database-dump-form'

type SetInput = { siteId: string; path: string | null }
const { set } = vi.hoisted(() => ({
  set: vi.fn<(input: SetInput) => Promise<DumpView & { liveDatabase: boolean }>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteDatabaseDump: {
      set: {
        mutationOptions: (options: UseMutationOptions<unknown, Error, SetInput>) => ({
          ...options,
          mutationFn: set,
        }),
      },
    },
  }),
}))

function show(initial: DumpView) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DatabaseDumpForm siteId={SITE_ID} initial={initial} />
    </QueryClientProvider>,
  )
}

const field = () => screen.getByLabelText<HTMLInputElement>(dumpText.field)

beforeEach(() => set.mockReset())

describe('the dump a preview takes its database from', () => {
  it('saves the file the owner names and shows it', async () => {
    set.mockResolvedValue({
      path: 'backup.sql',
      updatedAt: new Date('2026-10-26T09:00:00Z'),
      readable: true,
      liveDatabase: false,
    })
    show({ path: null, updatedAt: null, readable: true })
    expect(screen.getByText(dumpText.note)).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'backup.sql' } })
    fireEvent.click(screen.getByRole('button', { name: dumpText.save }))
    await waitFor(() => expect(screen.getByText('backup.sql')).toBeTruthy())
    expect(set).toHaveBeenCalledWith({ siteId: SITE_ID, path: 'backup.sql' }, expect.anything())
    expect(screen.getByRole('button', { name: dumpText.clear })).toBeTruthy()
  })

  it('says what is wrong with a path before sending it', () => {
    show({ path: null, updatedAt: null, readable: true })
    fireEvent.change(field(), { target: { value: '../backup.sql' } })
    fireEvent.click(screen.getByRole('button', { name: dumpText.save }))
    expect(screen.getByRole('alert').textContent).toBe(dumpText.invalid)
    expect(set).not.toHaveBeenCalled()
  })

  it('offers nothing to a site without a file source', () => {
    show({ path: null, updatedAt: null, readable: false })
    expect(screen.getByText(dumpText.noSource)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('forgets the dump on request', async () => {
    set.mockResolvedValue({ path: null, updatedAt: null, readable: true, liveDatabase: false })
    show({ path: 'backup.sql', updatedAt: null, readable: true })
    fireEvent.click(screen.getByRole('button', { name: dumpText.clear }))
    await waitFor(() => expect(field().value).toBe(''))
    expect(set).toHaveBeenCalledWith({ siteId: SITE_ID, path: null }, expect.anything())
  })
})
