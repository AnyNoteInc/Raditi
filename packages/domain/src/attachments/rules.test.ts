import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { feedLimits } from '../tasks/client-feed.ts'
import {
  attachmentAcceptAttribute,
  attachmentDeletable,
  attachmentExtension,
  attachmentFileName,
  attachmentKey,
  attachmentLimits,
  attachmentMimeTypes,
  attachmentStartInputSchema,
  attachmentStatuses,
  attachmentTypeByName,
  attachmentTypeOf,
  attachmentTypes,
  sniffAttachmentType,
} from './rules.ts'

const workspace = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8e'
const attachment = '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d8f'
const site = '018f3b2e-7c4a-8b1c-9d2e-3f4a5b6c7d90'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'string' ? Array.from(new TextEncoder().encode(part)) : part,
    ),
  )

// The first bytes of a real file of each type.
const samples: Record<string, Uint8Array> = {
  'image/jpeg': bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF'),
  'image/png': bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
    'IHDR',
  ),
  'image/webp': bytes('RIFF', [0x24, 0x00, 0x00, 0x00], 'WEBPVP8 '),
  'image/gif': bytes('GIF89a', [0x01, 0x00, 0x01, 0x00]),
  'application/pdf': bytes('%PDF-1.7\n%', [0xe2, 0xe3, 0xcf, 0xd3]),
  [DOCX]: bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': bytes([
    0x50, 0x4b, 0x03, 0x04,
  ]),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': bytes([
    0x50, 0x4b, 0x03, 0x04,
  ]),
  'application/vnd.oasis.opendocument.text': bytes([0x50, 0x4b, 0x03, 0x04], 'mimetype'),
  'application/vnd.oasis.opendocument.spreadsheet': bytes([0x50, 0x4b, 0x03, 0x04], 'mimetype'),
  'text/plain': bytes('Новость о выставке\nПриходите 12 ноября.'),
  'text/csv': bytes([0xef, 0xbb, 0xbf], 'Имя;Цена\nЧайник;1 200\n'),
}

describe('the list of types', () => {
  it('takes exactly the twelve types of the plan, each with a label', () => {
    expect(attachmentMimeTypes).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
      DOCX,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/plain',
      'text/csv',
    ])
    for (const type of attachmentTypes) {
      expect(type.label).toMatch(/^[А-ЯЁ]/u)
      expect(type.extensions.length).toBeGreaterThan(0)
    }
  })

  it('gives no two types the same extension', () => {
    const extensions = attachmentTypes.flatMap((type) => [...type.extensions])
    expect(new Set(extensions).size).toBe(extensions.length)
    for (const extension of extensions) expect(extension).toMatch(/^[a-z]+$/)
  })

  it('keeps the limits of the plan, and the feed takes as many files as a message', () => {
    expect(attachmentLimits.fileBytes).toBe(20 * 1024 * 1024)
    expect(attachmentLimits.perMessage).toBe(10)
    expect(feedLimits.attachments).toBe(attachmentLimits.perMessage)
  })

  it('finds a type by its MIME type, whatever the case and the parameters', () => {
    expect(attachmentTypeOf('image/jpeg')?.extensions).toEqual(['jpg', 'jpeg'])
    expect(attachmentTypeOf(' Text/CSV; charset=utf-8')?.mime).toBe('text/csv')
    for (const mime of ['', 'image/svg+xml', 'text/html', 'application/zip', 'image/jpg'])
      expect(attachmentTypeOf(mime)).toBeNull()
  })

  it('finds a type by the extension of a name, never by what the browser guessed', () => {
    expect(attachmentTypeByName('Фото.JPG')?.mime).toBe('image/jpeg')
    expect(attachmentTypeByName('прайс.csv')?.mime).toBe('text/csv')
    expect(attachmentTypeByName('отчёт.docx')?.mime).toBe(DOCX)
    for (const name of ['photo', 'photo.svg', 'site.php', 'photo.jpg.exe', 'archive.zip', '.jpg.'])
      expect(attachmentTypeByName(name)).toBeNull()
    expect(attachmentExtension('a.tar.GZ')).toBe('gz')
    expect(attachmentExtension('README')).toBeNull()
  })

  it('lists every extension and type for a file input', () => {
    expect(attachmentAcceptAttribute.split(',')).toContain('.jpeg')
    expect(attachmentAcceptAttribute.split(',')).toContain('text/csv')
    expect(attachmentAcceptAttribute).not.toContain(' ')
  })
})

describe('sniffAttachmentType', () => {
  it.each(Object.entries(samples))('takes %s by its first bytes', (mime, first) => {
    expect(sniffAttachmentType(first, mime)).toEqual({ ok: true, type: attachmentTypeOf(mime) })
  })

  it('checks the bytes against the declared type and guesses nothing', () => {
    expect(sniffAttachmentType(samples['image/png']!, 'image/jpeg')).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
    expect(sniffAttachmentType(samples['application/pdf']!, DOCX)).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
    // A script with an image's name.
    expect(sniffAttachmentType(bytes('<?php system($_GET["c"]);'), 'image/gif')).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
    // RIFF of a sound is not WebP.
    expect(sniffAttachmentType(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'image/webp')).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
    expect(sniffAttachmentType(bytes('GIF88a'), 'image/gif').ok).toBe(false)
  })

  it('refuses a type that is not on the list before it looks at the bytes', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/x-php', 'application/zip', ''])
      expect(sniffAttachmentType(samples['text/plain']!, mime)).toEqual({
        ok: false,
        reason: 'type_not_allowed',
      })
  })

  it('refuses no bytes and too few of them', () => {
    expect(sniffAttachmentType(new Uint8Array(), 'image/png')).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(sniffAttachmentType(new Uint8Array(), 'text/plain')).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(sniffAttachmentType(bytes([0xff, 0xd8]), 'image/jpeg').ok).toBe(false)
    expect(sniffAttachmentType(bytes('RIFF', [0, 0, 0, 0], 'WEB'), 'image/webp').ok).toBe(false)
  })

  it('takes text only as UTF-8 without a NUL byte', () => {
    const refused = { ok: false, reason: 'text_encoding' }
    // «Привет» in windows-1251.
    expect(sniffAttachmentType(bytes([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'text/csv')).toEqual(
      refused,
    )
    // UTF-16 with its byte order mark.
    expect(sniffAttachmentType(bytes([0xff, 0xfe, 0x41, 0x00]), 'text/plain')).toEqual(refused)
    expect(sniffAttachmentType(bytes('abc', [0], 'def'), 'text/plain')).toEqual(refused)
    expect(sniffAttachmentType(samples[DOCX]!, 'text/plain')).toEqual(refused)
    expect(sniffAttachmentType(bytes([0xed, 0xa0, 0x80]), 'text/plain')).toEqual(refused)
  })

  it('takes a prefix that ends inside a character, and reads no further than the prefix', () => {
    const text = new TextEncoder().encode('я'.repeat(attachmentLimits.sniffBytes))
    // Cut in the middle of a two-byte letter.
    expect(sniffAttachmentType(text.subarray(0, 4095), 'text/plain').ok).toBe(true)
    expect(sniffAttachmentType(bytes('Цена: 100 ', [0xe2, 0x82]), 'text/plain').ok).toBe(true)
    // What lies past the prefix is not looked at.
    const late = new Uint8Array(attachmentLimits.sniffBytes + 10).fill(0x61)
    late[attachmentLimits.sniffBytes + 5] = 0
    expect(sniffAttachmentType(late, 'text/plain').ok).toBe(true)
    late[attachmentLimits.sniffBytes - 1] = 0
    expect(sniffAttachmentType(late, 'text/plain').ok).toBe(false)
  })
})

describe('attachmentFileName', () => {
  it('keeps an ordinary name as it is', () => {
    for (const name of ['photo.jpg', 'Отчёт за май 2026.pdf', 'Прайс (новый).xlsx', 'a.b.c.txt'])
      expect(attachmentFileName(name)).toBe(name)
  })

  it('takes the last part of a path', () => {
    expect(attachmentFileName('C:\\fakepath\\фото.png')).toBe('фото.png')
    expect(attachmentFileName('../../etc/passwd')).toBe('passwd')
    expect(attachmentFileName('dir/')).toBeNull()
  })

  it('drops control, invisible and direction characters and replaces reserved ones', () => {
    expect(attachmentFileName('photo\u202Egpj.exe')).toBe('photogpj.exe')
    expect(attachmentFileName('a\u0000b\nc\u200B.pdf')).toBe('abc.pdf')
    expect(attachmentFileName('a\uD800b.pdf')).toBe('ab.pdf')
    expect(attachmentFileName('что? да: <нет>|*.txt')).toBe('что_ да_ _нет___.txt')
  })

  it('composes letters, joins spaces and trims dots and spaces at the ends', () => {
    // As macOS gives it: «й» decomposed.
    expect(attachmentFileName('\u0438\u0306.txt')).toBe('\u0439.txt')
    expect(attachmentFileName('  много   пробелов\t.pdf ')).toBe('много пробелов.pdf')
    expect(attachmentFileName('...hidden.jpg')).toBe('hidden.jpg')
    expect(attachmentFileName('photo.')).toBe('photo')
  })

  it('refuses a name with nothing left to call the file by', () => {
    for (const raw of ['', '   ', '...', '\u200B\u202E', '/', '.jpg', ' . .pdf'])
      expect(attachmentFileName(raw), JSON.stringify(raw)).toBeNull()
  })

  it('fits 255 bytes of UTF-8 and keeps the extension', () => {
    const long = attachmentFileName(`${'я'.repeat(300)}.docx`)!
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(255)
    expect(long.endsWith('я.docx')).toBe(true)
    expect(long).toBe(`${'я'.repeat(125)}.docx`)
    // Whole characters only: a pair is never split.
    const emoji = attachmentFileName(`${'😀'.repeat(100)}.png`)!
    expect(emoji).toBe(`${'😀'.repeat(62)}.png`)
    expect(emoji.isWellFormed()).toBe(true)
    // A long run of a «extension» that is not one is cut with the rest.
    const noExtension = attachmentFileName(`файл.${'x'.repeat(300)}`)!
    expect(new TextEncoder().encode(noExtension).byteLength).toBeLessThanOrEqual(255)
  })

  it('cuts an overlong name quickly and keeps its extension', () => {
    const started = performance.now()
    const marks = attachmentFileName(`a${'\u0301\u0323'.repeat(64_000)}.pdf`)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(marks?.endsWith('.pdf')).toBe(true)
    // The cut falls inside a pair: its half is dropped.
    expect(attachmentFileName(`a${'😀'.repeat(600)}.txt`)?.isWellFormed()).toBe(true)
  })

  it('is idempotent', () => {
    for (const raw of ['  a  b .pdf', `${'я'.repeat(300)}.docx`, 'x\u202E.txt', '\u0438\u0306.csv'])
      expect(attachmentFileName(attachmentFileName(raw)!)).toBe(attachmentFileName(raw))
  })
})

function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('attachmentKey', () => {
  it('builds inbox/<workspace>/<attachment>', () => {
    expect(attachmentKey(workspace, attachment)).toBe(`inbox/${workspace}/${attachment}`)
  })

  it('refuses anything but two lowercase ids', () => {
    for (const [ws, id] of [
      ['..', attachment],
      [workspace, '../x'],
      [workspace.toUpperCase(), attachment],
      [workspace, `${attachment}/x`],
      ['', attachment],
    ] as const)
      expect(isDomainError(thrown(() => attachmentKey(ws, id))), `${ws} ${id}`).toBe(true)
  })
})

describe('statuses', () => {
  it('lists the four of the plan and lets only an unsent file be removed', () => {
    expect(attachmentStatuses).toEqual(['uploading', 'ready', 'bound', 'deleted'])
    expect(attachmentStatuses.filter(attachmentDeletable)).toEqual(['uploading', 'ready'])
  })
})

describe('attachmentStartInputSchema', () => {
  const input = { siteId: site, name: 'фото.jpg', size: 1024, type: 'image/jpeg' }

  it('takes a file and returns its cleaned name', () => {
    expect(attachmentStartInputSchema.parse(input)).toEqual(input)
    expect(attachmentStartInputSchema.parse({ ...input, name: 'C:\\x\\ фото .JPG' })).toEqual({
      ...input,
      name: 'фото.JPG',
    })
  })

  it('bounds the size', () => {
    const accepts = (size: number) =>
      attachmentStartInputSchema.safeParse({ ...input, size }).success
    expect(accepts(1)).toBe(true)
    expect(accepts(20 * 1024 * 1024)).toBe(true)
    expect(accepts(20 * 1024 * 1024 + 1)).toBe(false)
    expect(accepts(0)).toBe(false)
    expect(accepts(1.5)).toBe(false)
  })

  it('wants a listed type that matches the extension of the name', () => {
    const accepts = (patch: Record<string, unknown>) =>
      attachmentStartInputSchema.safeParse({ ...input, ...patch }).success
    expect(accepts({ type: 'image/svg+xml', name: 'a.svg' })).toBe(false)
    expect(accepts({ type: 'image/png' })).toBe(false)
    expect(accepts({ name: 'фото.php' })).toBe(false)
    expect(accepts({ name: 'фото' })).toBe(false)
    expect(accepts({ name: 'таблица.csv', type: 'text/csv' })).toBe(true)
    expect(accepts({ name: 'таблица.csv', type: 'application/vnd.ms-excel' })).toBe(false)
  })

  it('refuses an empty or overlong name, a missing site and extra keys', () => {
    const accepts = (patch: Record<string, unknown>) =>
      attachmentStartInputSchema.safeParse({ ...input, ...patch }).success
    expect(accepts({ name: '...' })).toBe(false)
    expect(accepts({ name: `${'я'.repeat(1021)}.jpg` })).toBe(false)
    expect(accepts({ siteId: 'site-1' })).toBe(false)
    expect(accepts({ key: 'inbox/x' })).toBe(false)
  })
})
