import { describe, expect, it } from 'vitest'

import { artifactCellProblem, type ArtifactColumn } from './blocks.ts'
import {
  formatRubles,
  parseDay,
  parseRubles,
  parseTableCell,
  parseTsv,
  planTablePaste,
  plainRubles,
  tableCellPlain,
  tableCellText,
  tableCsv,
  tableMarkdown,
  tableOfBlocks,
  tableOrder,
  tableTotals,
  toTsv,
  type TableRow,
} from './table.ts'
import { artifactTemplateOf } from './templates.ts'

const name: ArtifactColumn = { key: 'name', name: 'Название', type: 'text' }
const price: ArtifactColumn = { key: 'price', name: 'Цена, ₽', type: 'money' }
const count: ArtifactColumn = { key: 'count', name: 'Кол-во', type: 'number' }
const day: ArtifactColumn = { key: 'day', name: 'Дата', type: 'date' }
const flag: ArtifactColumn = { key: 'flag', name: 'В наличии', type: 'checkbox' }
const kind: ArtifactColumn = {
  key: 'kind',
  name: 'Категория',
  type: 'select',
  options: ['Хлеб', 'Торты'],
}
const link: ArtifactColumn = { key: 'link', name: 'Ссылка', type: 'link' }
const columns = [name, price, count, day, flag, kind, link]

describe('the cells of a table read what a person typed (§7.7)', () => {
  it('reads sums in roubles as strings with two decimals, never a float (rule 9)', () => {
    expect(parseRubles('1 990,50')).toEqual({ ok: true, value: '1990.50' })
    expect(parseRubles('1.234,5 ₽')).toEqual({ ok: true, value: '1234.50' })
    expect(parseRubles('1,234.56')).toEqual({ ok: true, value: '1234.56' })
    expect(parseRubles('300 руб.')).toEqual({ ok: true, value: '300.00' })
    expect(parseRubles('−300')).toEqual({ ok: true, value: '-300.00' })
    expect(parseRubles('')).toEqual({ ok: true, value: null })
    expect(parseRubles('1,005').ok).toBe(false)
    expect(parseRubles('дорого').ok).toBe(false)
    expect(parseRubles('12345678901').ok).toBe(false)
    for (const raw of ['0,1', '99 999,99', '7']) {
      const parsed = parseRubles(raw)
      expect(parsed.ok && artifactCellProblem(price, parsed.value)).toBeNull()
    }
  })

  it('shows sums grouped and copies them plain', () => {
    expect(formatRubles('12900.00')).toBe('12\u00a0900')
    expect(formatRubles('1990.50')).toBe('1\u00a0990,50')
    expect(formatRubles('-300.00')).toBe('−300')
    expect(plainRubles('1234.50')).toBe('1234,50')
    expect(tableCellText(price, '1990.50')).toBe('1\u00a0990,50')
    expect(tableCellPlain(price, '1990.50')).toBe('1990,50')
  })

  it('reads days, flags, choices, numbers and links', () => {
    expect(parseDay('12.11.2026')).toBe('2026-11-12')
    expect(parseDay('1.2.26')).toBe('2026-02-01')
    expect(parseDay('2026-02-31')).toBeNull()
    expect(parseTableCell(day, '31.02.2026').ok).toBe(false)
    expect(tableCellText(day, '2026-11-12')).toBe('12.11.2026')
    expect(parseTableCell(flag, 'Да')).toEqual({ ok: true, value: true })
    expect(parseTableCell(flag, 'нет')).toEqual({ ok: true, value: false })
    expect(parseTableCell(flag, 'может').ok).toBe(false)
    expect(parseTableCell(kind, 'торты')).toEqual({ ok: true, value: 'Торты' })
    expect(parseTableCell(kind, 'Пироги')).toEqual({
      ok: false,
      reason: 'Нет такого варианта: «Пироги»',
    })
    expect(parseTableCell(count, '3,5')).toEqual({ ok: true, value: 3.5 })
    expect(parseTableCell(count, 'много').ok).toBe(false)
    expect(parseTableCell(link, 'example.ru/a')).toEqual({
      ok: true,
      value: 'https://example.ru/a',
    })
    expect(parseTableCell(link, 'http://example.ru').ok).toBe(false)
    expect(parseTableCell(link, 'javascript:alert(1)').ok).toBe(false)
    expect(parseTableCell(name, '')).toEqual({ ok: true, value: null })
  })
})

describe('the clipboard and CSV (§7.7)', () => {
  it('reads tab-separated text as Excel and Google Sheets write it, and back', () => {
    const text = 'Хлеб\t"Бородинский ""классика"""\r\n"две\nстроки"\t1 200\r\n'
    expect(parseTsv(text)).toEqual([
      ['Хлеб', 'Бородинский "классика"'],
      ['две\nстроки', '1 200'],
    ])
    const matrix = [
      ['a\tb', 'c'],
      ['"', ''],
    ]
    expect(parseTsv(toTsv(matrix))).toEqual(matrix)
  })

  it('writes CSV with «;», a byte order mark, CRLF and neutralized formulas', () => {
    const csv = tableCsv(
      [name, price, flag],
      [{ cells: { name: '=HYPERLINK("x")', price: '1234.50', flag: true } }, { cells: {} }],
    )
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toBe(
      '\uFEFFНазвание;Цена, ₽;В наличии\r\n"\'=HYPERLINK(""x"")";1234,50;да\r\n;;нет\r\n',
    )
  })
})

describe('a paste from Excel (§7.7, spike 5)', () => {
  const view = ['r1', 'r2']

  it('goes right and down from the anchor, rows past the end become new rows', () => {
    const plan = planTablePaste({
      view,
      columns,
      matrix: [
        ['Батон', '45'],
        ['Торт', 'много'],
        ['Пирог', '300'],
      ],
      rect: { r0: 1, r1: 1, c0: 0, c1: 0 },
      rowCount: 2,
    })
    expect(plan.changes).toEqual([{ key: 'r2', cells: { name: 'Батон', price: '45.00' } }])
    expect(plan.inserts).toEqual([{ name: 'Торт' }, { name: 'Пирог', price: '300.00' }])
    expect(plan.refused).toBe(1)
    expect(plan.reasons).toEqual(['Введите сумму, например 1 250,50'])
  })

  it('fills a selection with one value, and stops at the limit of rows', () => {
    const filled = planTablePaste({
      view,
      columns,
      matrix: [['да']],
      rect: { r0: 0, r1: 1, c0: 4, c1: 4 },
      rowCount: 2,
    })
    expect(filled.filled).toBe(true)
    expect(filled.changes).toEqual([
      { key: 'r1', cells: { flag: true } },
      { key: 'r2', cells: { flag: true } },
    ])
    const full = planTablePaste({
      view,
      columns,
      matrix: [['a'], ['b'], ['c']],
      rect: { r0: 1, r1: 1, c0: 0, c1: 0 },
      rowCount: 4999,
    })
    expect(full.inserts).toHaveLength(1)
    expect(full.clippedRows).toBe(1)
    const wide = planTablePaste({
      view,
      columns,
      matrix: [['x', 'y', 'z']],
      rect: { r0: 0, r1: 0, c0: 6, c1: 6 },
      rowCount: 2,
    })
    expect(wide.clippedColumns).toBe(2)
  })
})

describe('the order of rows and the totals', () => {
  const rows: TableRow[] = [
    { key: 'a', rev: 1, cells: { name: 'Ёлка', price: '100.00', count: 2 } },
    { key: 'b', rev: 1, cells: { name: 'батон', price: '9.50' } },
    { key: 'c', rev: 1, cells: { name: 'Арбуз', count: 0.1 } },
  ]

  it('sorts by the request, empty cells last both ways, and filters by words', () => {
    expect(
      tableOrder({ rows, columns, sort: [{ key: 'price', desc: false }], search: '' }),
    ).toEqual(['b', 'a', 'c'])
    expect(tableOrder({ rows, columns, sort: [{ key: 'price', desc: true }], search: '' })).toEqual(
      ['a', 'b', 'c'],
    )
    expect(tableOrder({ rows, columns, sort: [{ key: 'name', desc: false }], search: '' })).toEqual(
      ['c', 'b', 'a'],
    )
    expect(tableOrder({ rows, columns, sort: [], search: 'елка' })).toEqual(['a'])
  })

  it('sums money as Decimal strings and numbers exactly', () => {
    expect(tableTotals(columns, rows)).toEqual({ price: '109.50', count: '2.1' })
    expect(tableTotals(columns, [])).toEqual({})
  })

  it('reads the blocks of a template and draws a Markdown table', () => {
    const template = artifactTemplateOf('price-list')!
    const table = tableOfBlocks(
      template.blocks.map((block, index) => ({
        key: `b${index + 1}`,
        kind: block.kind,
        rev: 1,
        content: block.content,
      })),
    )
    expect(table.columnsKey).toBe('b1')
    expect(table.rows).toHaveLength(3)
    for (const row of table.rows)
      for (const [key, value] of Object.entries(row.cells))
        expect(
          artifactCellProblem(
            table.columns.find((c) => c.key === key)!,
            value,
          ),
        ).toBeNull()
    const markdown = tableMarkdown(table.columns, table.rows)
    expect(markdown.split('\n')[0]).toBe(
      '| Название | Категория | Ед. | Цена, ₽ | В наличии | Примечание |',
    )
    expect(markdown).toContain('| 990 ₽ |')
    expect(tableMarkdown([name], [{ cells: { name: 'a|b' } }])).toContain('a\\|b')
  })
})
