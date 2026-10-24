import { describe, expect, it } from 'vitest'

import {
  attachmentExtensionsText,
  attachmentHintText,
  attachmentRefusalText,
  attachmentSizeText,
  attachmentTypeLabel,
} from './labels.ts'
import { attachmentRefusals, attachmentTypes } from './rules.ts'

// «ты» and its forms as whole words: the customer is addressed with «вы».
const informal = /(^|[^\p{L}])(ты|тебя|тебе|твой|твоя|твои)([^\p{L}]|$)/iu

describe('attachmentSizeText', () => {
  it('reads bytes, kilobytes and megabytes the way the cabinet writes them', () => {
    expect(attachmentSizeText(0)).toBe('0 байт')
    expect(attachmentSizeText(1)).toBe('1 байт')
    expect(attachmentSizeText(3)).toBe('3 байта')
    expect(attachmentSizeText(512)).toBe('512 байт')
    expect(attachmentSizeText(1024)).toBe('1 КБ')
    expect(attachmentSizeText(12 * 1024)).toBe('12 КБ')
    expect(attachmentSizeText(1023 * 1024 + 900)).toBe('1 МБ')
    expect(attachmentSizeText(1.44 * 1024 * 1024)).toBe('1,4 МБ')
    expect(attachmentSizeText(20 * 1024 * 1024)).toBe('20 МБ')
  })

  it('never prints a broken number', () => {
    for (const value of [-5, Number.NaN, Number.POSITIVE_INFINITY, 1.7])
      expect(attachmentSizeText(value)).toMatch(/^\d+(,\d)? (байт|байта|КБ|МБ)$/u)
  })
})

describe('labels', () => {
  it('names every listed type and a stranger as «Файл»', () => {
    for (const type of attachmentTypes) expect(attachmentTypeLabel(type.mime)).toBe(type.label)
    expect(attachmentTypeLabel('IMAGE/PNG')).toBe('Изображение PNG')
    expect(attachmentTypeLabel('application/x-php')).toBe('Файл')
  })

  it('has a refusal text for every rule, in Russian and with «вы»', () => {
    expect(Object.keys(attachmentRefusalText).sort()).toEqual([...attachmentRefusals].sort())
    for (const text of [...Object.values(attachmentRefusalText), attachmentHintText]) {
      expect(text).not.toMatch(informal)
      expect(text.endsWith('.')).toBe(true)
      expect(text).toMatch(/^[А-ЯЁ]/u)
    }
    expect(attachmentRefusalText.too_large).toContain('20 МБ')
    expect(attachmentRefusalText.too_many).toContain('10 файлов')
    expect(attachmentHintText).toContain('20 МБ')
  })

  it('names every extension, and no type a page cannot take', () => {
    expect(attachmentExtensionsText).toBe(
      'JPG, JPEG, PNG, WEBP, GIF, PDF, DOCX, XLSX, PPTX, ODT, ODS, TXT, CSV',
    )
    expect(attachmentRefusalText.type_not_allowed).toContain(attachmentExtensionsText)
  })
})
