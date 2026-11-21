// @vitest-environment jsdom
import { artifactTemplateOf } from '@repo/domain/artifacts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactTable } from './artifact-table'
import { batchesOf, layoutOf, shownColumns } from './table-model'

// «Таблица» in the cabinet (docs/plan/88-artifacts.md, §7.7; slice 88.14): the grid at 600 px
// and wider, cards below; an edit is a `cells` operation, a paste from Excel goes right and down
// and adds rows, Ctrl+Z takes the person's own edit back, a row an agent holds is left out and
// named; the totals are the server's.

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000a1'

const { write, totals, exportStart, exportStatus } = vi.hoisted(() => ({
  write: vi.fn(async (_input: unknown) => ({
    artifactId: '019f1a21-1800-7f00-8abc-0000000000a1',
    opId: 'x',
    seq: 9,
    blocks: [],
    title: null,
    repeated: false,
  })),
  totals: vi.fn(async (_input: unknown) => ({ totals: { price: '2790.00' }, rows: 3 })),
  exportStart: vi.fn(async (_input: unknown) => ({
    exportId: '019f1a21-1800-7f00-8abc-0000000000e1',
  })),
  exportStatus: vi.fn(async (_input: unknown) => ({ state: 'ready' as const })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    artifact: {
      write: { mutationOptions: () => ({ mutationFn: write }) },
      exportStart: { mutationOptions: () => ({ mutationFn: exportStart }) },
      tableTotals: {
        queryOptions: (input: unknown) => ({
          queryKey: ['tableTotals', input],
          queryFn: () => totals(input),
        }),
      },
    },
  }),
  useTRPCClient: () => ({ artifact: { exportStatus: { query: exportStatus } } }),
}))

/** The price list of the template as the server reads it back. */
function priceList(): CabinetArtifact {
  const template = artifactTemplateOf('price-list')!
  return {
    id: ARTIFACT,
    kind: 'table',
    title: 'Прайс-лист',
    seq: 8,
    role: 'owner',
    version: 1,
    project: null,
    updatedAt: '2026-11-21T10:00:00.000Z',
    blocks: template.blocks.map((block, index) => ({
      key: index === 0 ? 'cols' : `r${index}`,
      kind: block.kind,
      parent: null,
      rank: `0${index + 1}`,
      props: {},
      rev: 1,
      heading: null,
      content: block.content,
      checking: false,
      hold: null,
    })),
  }
}

let width = 1000
const rect = (w: number) => ({
  width: w,
  height: 600,
  top: 0,
  left: 0,
  bottom: 600,
  right: w,
  x: 0,
  y: 0,
  toJSON: () => ({}),
})

beforeEach(() => {
  width = 1000
  write.mockClear()
  totals.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => rect(width) as DOMRect,
  )
  // jsdom measures nothing: the scroller of the rows has the size of a screen.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
})
afterEach(() => vi.restoreAllMocks())

function show(value: CabinetArtifact = priceList()) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const changed = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ArtifactTable artifact={value} presence={null} onChanged={changed} place="page" />
    </QueryClientProvider>,
  )
  return { changed }
}

const batchOf = (call: number) =>
  (write.mock.calls[call]![0] as { batch: { ops: Record<string, unknown>[] } }).batch

describe('the grid of a table', () => {
  it('shows the columns, the rows and the totals of the server, with the roles of a grid', async () => {
    show()
    const grid = screen.getByRole('grid', { name: 'Таблица «Прайс-лист»' })
    expect(within(grid).getByRole('columnheader', { name: 'Цена, ₽' })).toBeTruthy()
    expect(within(grid).getByText('[Товар]')).toBeTruthy()
    expect(document.getElementById(`table-${ARTIFACT}-r2-price`)?.textContent).toBe('1\u00a0500')
    await waitFor(() =>
      expect(
        within(grid).getByText((_, element) => element?.textContent === '2\u00a0790'),
      ).toBeTruthy(),
    )
    expect(totals).toHaveBeenCalledWith({ artifactId: ARTIFACT, rows: null })
  })

  it('edits a cell from the keyboard, then takes it back by Ctrl+Z', async () => {
    show()
    const grid = screen.getByRole('grid')
    act(() => grid.focus())
    // To the price of the first row: three to the right.
    for (let i = 0; i < 3; i += 1)
      fireEvent.keyDown(grid, { code: 'ArrowRight', key: 'ArrowRight' })
    fireEvent.keyDown(grid, { code: 'Digit1', key: '1' })
    const input = await screen.findByRole('textbox', { name: 'Цена, ₽' })
    fireEvent.change(input, { target: { value: '1 250,50' } })
    fireEvent.keyDown(input, { code: 'Enter', key: 'Enter' })
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(batchOf(0).ops).toEqual([{ op: 'cells', block: 'r1', cells: { price: '1250.50' } }])
    act(() => grid.focus())
    fireEvent.keyDown(grid, { code: 'KeyZ', key: 'я', ctrlKey: true })
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(batchOf(1).ops).toEqual([{ op: 'cells', block: 'r1', cells: { price: '990.00' } }])
  })

  it('pastes a block from Excel right and down, past the end as new rows, and says what did not fit', async () => {
    show()
    const grid = screen.getByRole('grid')
    act(() => grid.focus())
    fireEvent.keyDown(grid, { code: 'ArrowDown', key: 'ArrowDown' })
    fireEvent.keyDown(grid, { code: 'ArrowDown', key: 'ArrowDown' })
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string }
    }
    paste.clipboardData = { getData: () => 'Батон\tХлеб\r\nТорт\tУслуги\r\n' }
    act(() => {
      document.dispatchEvent(paste)
    })
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    const ops = batchOf(0).ops
    expect(ops[0]).toEqual({ op: 'cells', block: 'r3', cells: { name: 'Батон' } })
    expect(ops[1]).toMatchObject({ op: 'insert', kind: 'row', after: 'r3' })
    expect(JSON.parse(ops[1]!.content as string)).toEqual({ name: 'Торт', category: 'Услуги' })
    expect(await screen.findByText(/не подошли 1/)).toBeTruthy()
  })

  it('leaves out a row an agent holds and names it', async () => {
    write.mockRejectedValueOnce(
      Object.assign(new Error('held'), {
        data: { domainCode: 'ARTIFACT_BLOCK_HELD', artifact: { block: 'r1', reason: 'checking' } },
      }),
    )
    show()
    const grid = screen.getByRole('grid')
    act(() => grid.focus())
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string }
    }
    paste.clipboardData = { getData: () => 'А\r\nБ\r\n' }
    act(() => {
      document.dispatchEvent(paste)
    })
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(batchOf(1).ops).toEqual([{ op: 'cells', block: 'r2', cells: { name: 'Б' } }])
    expect(
      await screen.findByText(/сейчас пишет агент: «А»|сейчас пишет агент: «\[Товар\]»/),
    ).toBeTruthy()
  })
})

describe('the cards of a table in a narrow area', () => {
  it('shows a card a row and flips the flag on the card', async () => {
    width = 390
    show()
    const list = await screen.findByRole('list', { name: 'Строки таблицы «Прайс-лист»' })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    const button = within(cards[0]!).getByRole('button')
    expect(button.getAttribute('aria-label')).toBe('[Товар], 990 ₽. Изменить')
    fireEvent.click(within(cards[0]!).getByRole('switch'))
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(batchOf(0).ops).toEqual([{ op: 'cells', block: 'r1', cells: { 'in-stock': false } }])
  })

  it('opens the row in a sheet with its heading and the sum on the digits of the phone', async () => {
    width = 390
    show()
    const list = await screen.findByRole('list')
    fireEvent.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button'))
    const sheet = await screen.findByRole('dialog', { name: 'Строка «[Услуга]»' })
    const price = within(sheet).getByRole('textbox', { name: 'Цена, ₽' })
    expect(price.getAttribute('inputmode')).toBe('decimal')
    fireEvent.change(price, { target: { value: '1 600' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(batchOf(0).ops).toEqual([{ op: 'cells', block: 'r2', cells: { price: '1600.00' } }])
  })
})

describe('what the table of the cabinet keeps', () => {
  it('splits a large paste into batches the server takes', () => {
    const ops = Array.from({ length: 2000 }, (_, index) => ({
      op: 'insert' as const,
      block: `r-${index}`,
      after: null,
      kind: 'row' as const,
      content: JSON.stringify({ name: 'x'.repeat(40), price: '1.00' }),
    }))
    const batches = batchesOf(ops)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toHaveLength(2000)
    for (const batch of batches)
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThan(90 * 1024)
    const deletes = Array.from({ length: 120 }, (_, index) => ({
      op: 'delete' as const,
      block: `r-${index}`,
      ifRev: 1,
    }))
    expect(batchesOf(deletes).map((batch) => batch.length)).toEqual([50, 50, 20])
  })

  it('shows the pinned columns first and forgets columns that are gone', () => {
    const columns = [
      { key: 'a', name: 'A', type: 'text' as const },
      { key: 'b', name: 'B', type: 'text' as const },
      { key: 'c', name: 'C', type: 'text' as const },
    ]
    const layout = layoutOf(columns, { order: ['x', 'c', 'a'], hidden: ['b'], pinned: ['a'] })
    expect(layout).toEqual({ order: ['c', 'a', 'b'], hidden: ['b'], pinned: ['a'] })
    expect(shownColumns(columns, layout).map((column) => column.key)).toEqual(['a', 'c'])
    expect(layoutOf(columns, null).pinned).toEqual(['a'])
  })
})
