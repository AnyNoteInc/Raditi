import type { ArtifactColumn } from '@repo/domain/artifacts'
import { readSheet } from 'read-excel-file/node'
import { describe, expect, it } from 'vitest'

import { workbookBytes } from './workbook.ts'

// The workbook of a table (docs/plan/88-artifacts.md, §7.13, question 26), read back by
// read-excel-file as Excel would read it.

const columns: ArtifactColumn[] = [
  { key: 'name', name: 'Название', type: 'text' },
  { key: 'price', name: 'Цена, ₽', type: 'money' },
  { key: 'day', name: 'Дата', type: 'date' },
  { key: 'stock', name: 'В наличии', type: 'checkbox' },
  { key: 'count', name: 'Кол-во', type: 'number' },
  { key: 'photo', name: 'Фото', type: 'image' },
]

describe('the workbook of a table', () => {
  it('has the names of the columns, sums as numbers, days as dates and formulas as text', async () => {
    const bytes = await workbookBytes({
      title: 'Прайс: хлеб/торты',
      columns,
      rows: [
        { cells: { name: 'Батон', price: '1990.50', day: '2026-11-12', stock: true, count: 3 } },
        { cells: { name: '=1+1' } },
      ],
    })
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK')
    const sheet = await readSheet(Buffer.from(bytes))
    expect(sheet[0]).toEqual(['Название', 'Цена, ₽', 'Дата', 'В наличии', 'Кол-во'])
    expect(sheet[1]?.[0]).toBe('Батон')
    expect(sheet[1]?.[1]).toBe(1990.5)
    expect(sheet[1]?.[2]).toEqual(new Date('2026-11-12T00:00:00Z'))
    expect(sheet[1]?.[3]).toBe('да')
    expect(sheet[1]?.[4]).toBe(3)
    expect(sheet[2]?.[0]).toBe('=1+1')
    expect(sheet[2]?.[3]).toBe('нет')
  })
})
