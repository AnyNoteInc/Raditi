import { Decimal } from 'decimal.js'

/** A row of the price list. A price is a canonical decimal string («1234.50»), never a float (rule 9). */
export interface PriceRow {
  id: string
  name: string
  category: string
  unit: string
  price: string
  inStock: boolean
  note: string
}

export type ColumnId = 'name' | 'category' | 'unit' | 'price' | 'inStock' | 'note'
export type ColumnKind = 'text' | 'select' | 'money' | 'checkbox'
export type CellValue = string | boolean

export interface ColumnSpec {
  id: ColumnId
  label: string
  kind: ColumnKind
  width: number
  align?: 'right' | 'center'
  options?: readonly string[]
  maxLength?: number
  multiline?: boolean
}

export const CATEGORIES = [
  'Хлеб',
  'Пироги',
  'Торты',
  'Выпечка',
  'Десерты',
  'Напитки',
  'Сэндвичи',
  'Салаты',
] as const

export const COLUMNS: readonly ColumnSpec[] = [
  { id: 'name', label: 'Название', kind: 'text', width: 280, maxLength: 200 },
  { id: 'category', label: 'Категория', kind: 'select', width: 150, options: CATEGORIES },
  { id: 'unit', label: 'Ед.', kind: 'text', width: 96, maxLength: 20 },
  { id: 'price', label: 'Цена, ₽', kind: 'money', width: 132, align: 'right' },
  { id: 'inStock', label: 'В наличии', kind: 'checkbox', width: 112, align: 'center' },
  { id: 'note', label: 'Примечание', kind: 'text', width: 340, maxLength: 1000, multiline: true },
]

export const COLUMN_IDS = COLUMNS.map((c) => c.id)
export const columnById = new Map(COLUMNS.map((c) => [c.id, c]))

/** Limits of the table kind, as in plan 88 §7.12 and §7.2. */
export const LIMITS = {
  rows: 5000,
  opsPerBatch: 50,
  batchBytes: 90 * 1024,
  blockBytes: 32 * 1024,
} as const

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

/**
 * «12 900», «1 990,50» — the same reading as `apps/web/src/lib/rubles.ts` of the cabinet:
 * no-break spaces between groups, a comma before kopecks, no «,00».
 */
export function formatRubles(value: string): string {
  if (value === '') return ''
  const [rubles = '0', kopecks = '00'] = new Money(value).toFixed(2).split('.')
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${grouped}${kopecks === '00' ? '' : `,${kopecks}`}`
}

/** A price as it goes into a clipboard, CSV or an editor: «1234,50», no grouping. */
export function plainRubles(value: string): string {
  if (value === '') return ''
  const [rubles = '0', kopecks = '00'] = new Money(value).toFixed(2).split('.')
  return kopecks === '00' ? rubles : `${rubles},${kopecks}`
}

export type Parsed = { ok: true; value: CellValue } | { ok: false; reason: string }

const MAX_PRICE = new Money('99999999.99')
const CURRENCY = /^(?:₽|руб\.?|р\.|rub)\s*|\s*(?:₽|руб(?:лей|ля|ль)?\.?|р\.|rub)$/giu
const GROUP_SPACES = /[\s   ']/g

/** Reads a price typed by a person or pasted from Excel or Google Sheets. */
export function parseRubles(raw: string): Parsed {
  let text = raw.trim().replace(CURRENCY, '').trim()
  if (text === '') return { ok: true, value: '' }
  if (text.startsWith('-') || text.startsWith('−')) {
    return { ok: false, reason: 'Цена не может быть меньше нуля' }
  }
  text = text.replace(GROUP_SPACES, '')
  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    // «1,234.56» or «1.234,56»: the last mark separates kopecks, the other one groups.
    const decimalMark = comma > dot ? ',' : '.'
    const groupMark = decimalMark === ',' ? '.' : ','
    text = text.split(groupMark).join('').replace(decimalMark, '.')
  } else if (comma >= 0) {
    if (text.indexOf(',') !== comma) return { ok: false, reason: 'Непонятное число' }
    text = text.replace(',', '.')
  } else if (dot >= 0 && text.indexOf('.') !== dot) {
    text = text.split('.').join('')
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: 'Введите число, например 1 250,50' }
  const fraction = text.split('.')[1] ?? ''
  if (fraction.length > 2) return { ok: false, reason: 'Не больше двух знаков после запятой' }
  const value = new Money(text)
  if (value.greaterThan(MAX_PRICE)) return { ok: false, reason: 'Слишком большая цена' }
  return { ok: true, value: value.toFixed(2) }
}

const TRUE_WORDS = new Set(['да', 'true', 'истина', '1', '+', 'x', 'х', '✓', '✔', 'yes', 'есть'])
const FALSE_WORDS = new Set(['нет', 'false', 'ложь', '0', '-', '', 'no'])

export function parseFlag(raw: string): Parsed {
  const word = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return { ok: true, value: true }
  if (FALSE_WORDS.has(word)) return { ok: true, value: false }
  return { ok: false, reason: 'Ожидается «да» или «нет»' }
}

export function fold(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е')
}

export function parseOption(column: ColumnSpec, raw: string): Parsed {
  const word = fold(raw.trim())
  if (word === '') return { ok: true, value: '' }
  const option = column.options?.find((o) => fold(o) === word)
  return option ? { ok: true, value: option } : { ok: false, reason: `Нет такого варианта: «${raw.trim()}»` }
}

/** Turns what a person typed or pasted into the value of a cell, or a reason in Russian. */
export function parseCell(column: ColumnSpec, raw: string): Parsed {
  switch (column.kind) {
    case 'money':
      return parseRubles(raw)
    case 'checkbox':
      return parseFlag(raw)
    case 'select':
      return parseOption(column, raw)
    case 'text': {
      const value = column.multiline ? raw.replace(/\r\n?/g, '\n') : raw.replace(/[\r\n]+/g, ' ')
      if (column.maxLength && value.length > column.maxLength) {
        return { ok: false, reason: `Не длиннее ${column.maxLength} знаков` }
      }
      return { ok: true, value }
    }
  }
}

/** The text of a cell for the screen. */
export function displayCell(column: ColumnSpec, row: PriceRow): string {
  const value = row[column.id]
  if (column.kind === 'money') return formatRubles(value as string)
  if (column.kind === 'checkbox') return value ? 'да' : 'нет'
  return value as string
}

/** The text of a cell for an editor, the clipboard and CSV. */
export function plainCell(column: ColumnSpec, row: PriceRow): string {
  const value = row[column.id]
  if (column.kind === 'money') return plainRubles(value as string)
  if (column.kind === 'checkbox') return value ? 'да' : 'нет'
  return value as string
}

export function emptyValue(column: ColumnSpec): CellValue {
  return column.kind === 'checkbox' ? false : ''
}

export function kopecks(price: string): bigint | null {
  if (price === '') return null
  const [rubles = '0', fraction = '00'] = price.split('.')
  return BigInt(rubles) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
}
