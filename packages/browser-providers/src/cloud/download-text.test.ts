import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { browserDownloadLimits } from '@repo/domain'

import { decodeText, downloadKindOf, readDownload } from './download-text.ts'

/** A zip as Excel writes one: deflated entries, a central directory, its end. */
function zip(files: Record<string, string>, stored = false): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8')
    const body = stored ? raw : deflateRawSync(raw)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

const workbook = (sheet: string) => ({
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="Заявки &amp; звонки" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<sst><si><t>Имя</t></si><si><t>Телефон</t></si><si><r><t>Анна</t></r><r><t xml:space="preserve"> Петрова</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': sheet,
})

describe('readDownload', () => {
  it('reads an Excel workbook as tab-separated rows under the name of its sheet', () => {
    const bytes = zip(
      workbook(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>a\tb</t></is></c></row>' +
          '<row r="3"><c r="B3"><v>79990001122</v></c></row>' +
          '<row r="4"><c r="A4"/></row>' +
          '</sheetData></worksheet>',
      ),
    )
    expect(readDownload({ name: 'export.xlsx', bytes })).toEqual({
      kind: 'workbook',
      text: '## Заявки & звонки\nИмя\tТелефон\nАнна Петрова\t\ta b\n\t79990001122',
    })
    // The name does not decide: a workbook sent without its extension is still one.
    expect(readDownload({ name: 'download', bytes }).kind).toBe('workbook')
  })

  it('does not pad rows of empty far cells: such a sheet reads at once, whatever its size', () => {
    // 50 000 rows of one empty cell at XFD1 used to cost 16 383 pushes each — about 3.6 s of the
    // shared worker's only thread for a file of a few kilobytes, a minute at the unpack limit.
    const rows = '<row><c r="XFD1"/></row>'.repeat(50_000)
    const bytes = zip(workbook(`<worksheet><sheetData>${rows}</sheetData></worksheet>`))
    const started = performance.now()
    expect(readDownload({ name: 'a.xlsx', bytes })).toEqual({
      kind: 'workbook',
      text: '## Заявки & звонки',
    })
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('reads elements that never close in linear time: a tiny file cannot hold the worker for minutes', () => {
    // A lazy `[\s\S]*?` looked for the end of each of these starts to the end of the text:
    // 40 000 of them took 1.5–2.5 s, and a doubling of the text quadrupled the time.
    const unclosed = 100_000
    const shapes: Record<string, Parameters<typeof workbook>[0]> = {
      rows: `<worksheet><sheetData>${'<row>'.repeat(unclosed)}`,
      cells: `<worksheet><sheetData><row>${'<c r="A1">'.repeat(unclosed)}</row></sheetData></worksheet>`,
      values: `<worksheet><sheetData><row><c r="A1">${'<v>'.repeat(unclosed)}</c></row></sheetData></worksheet>`,
    }
    for (const sheet of Object.values(shapes)) {
      const started = performance.now()
      expect(readDownload({ name: 'a.xlsx', bytes: zip(workbook(sheet)) }).kind).toBe('workbook')
      expect(performance.now() - started).toBeLessThan(1000)
    }
    // Shared strings and runs of text.
    const strings = zip({
      ...workbook(
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      ),
      'xl/sharedStrings.xml': `<sst>${'<si><t>'.repeat(unclosed)}`,
    })
    const started = performance.now()
    expect(readDownload({ name: 'a.xlsx', bytes: strings }).kind).toBe('workbook')
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('does not mistake <col>, <cfRule> or <sheets> for a cell or a sheet, and reads an empty row', () => {
    const bytes = zip(
      workbook(
        '<worksheet><cols><col min="1" max="2"/></cols><sheetData>' +
          '<row r="1"/>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c></row>' +
          '</sheetData><conditionalFormatting><cfRule type="x"><formula>1</formula></cfRule></conditionalFormatting></worksheet>',
      ),
    )
    // The empty row does not swallow the row behind it.
    expect(readDownload({ name: 'a.xlsx', bytes }).text).toBe('## Заявки & звонки\nx')
  })

  it('keeps the place of a cell behind empty ones and of a cell that names none', () => {
    const bytes = zip(
      workbook(
        '<worksheet><sheetData>' +
          '<row><c r="A1"/><c r="C1" t="inlineStr"><is><t>c</t></is></c><c r="D1"/></row>' +
          '<row><c t="inlineStr"><is><t></t></is></c><c t="inlineStr"><is><t>b</t></is></c></row>' +
          '</sheetData></worksheet>',
      ),
    )
    // Row 1: A and B empty, C filled, D empty (no trailing tab). Row 2: cells with no reference
    // take the next places in turn, an empty one among them.
    expect(readDownload({ name: 'a.xlsx', bytes }).text).toBe('## Заявки & звонки\n\t\tc\n\tb')
  })

  it('keeps a character reference that names no character as written instead of failing the file', () => {
    const bytes = zip(
      workbook(
        '<worksheet><sheetData><row r="1">' +
          '<c r="A1" t="inlineStr"><is><t>&#1055;&#x420;&#x110000;&#99999999999;&#xD800;&#0;</t></is></c>' +
          '</row></sheetData></worksheet>',
      ),
    )
    expect(readDownload({ name: 'a.xlsx', bytes })).toEqual({
      kind: 'workbook',
      text: '## Заявки & звонки\nПР&#x110000;&#99999999999;&#xD800;&#0;',
    })
  })

  it('reads a workbook stored without compression', () => {
    const bytes = zip(
      workbook('<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>'),
      true,
    )
    expect(readDownload({ name: 'a.xlsx', bytes }).text).toBe('## Заявки & звонки\nИмя')
  })

  it('takes a zip without a workbook, a PDF and a broken zip for what they are', () => {
    expect(readDownload({ name: 'a.zip', bytes: zip({ 'a.txt': 'x' }) })).toEqual({
      kind: 'binary',
      text: null,
    })
    expect(readDownload({ name: 'a.pdf', bytes: Buffer.from('%PDF-1.7') })).toEqual({
      kind: 'binary',
      text: null,
    })
    const broken = zip(workbook('<worksheet/>')).slice(0, 40)
    expect(readDownload({ name: 'a.xlsx', bytes: broken })).toEqual({ kind: 'failed', text: null })
  })

  it('reads a CSV in UTF-8 with a BOM and in Windows-1251', () => {
    const utf8 = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Имя;Телефон\n', 'utf8'),
    ])
    expect(readDownload({ name: 'entries.csv', bytes: utf8 })).toEqual({
      kind: 'text',
      text: 'Имя;Телефон\n',
    })
    // «Имя» in Windows-1251.
    const cp1251 = Buffer.from([0xc8, 0xec, 0xff, 0x3b, 0x31, 0x0a])
    expect(readDownload({ name: 'entries.CSV', bytes: cp1251 }).text).toBe('Имя;1\n')
  })

  it('does not take a binary file named .txt for text', () => {
    expect(decodeText(Buffer.from([0x41, 0x00, 0x42]))).toBeNull()
    expect(readDownload({ name: 'a.txt', bytes: Buffer.from([0x41, 0x00]) }).kind).toBe('binary')
  })

  it('refuses a cell past the last column of Excel instead of building its row', () => {
    for (const reference of ['ZZZZZZZZZZ1', 'XFE1', 'AAAA1']) {
      const bytes = zip(
        workbook(
          `<worksheet><sheetData><row><c r="${reference}" t="s"><v>0</v></c></row></sheetData></worksheet>`,
        ),
      )
      expect(readDownload({ name: 'a.xlsx', bytes }), reference).toEqual({
        kind: 'failed',
        text: null,
      })
    }
    const last = zip(
      workbook(
        '<worksheet><sheetData><row><c r="XFD1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      ),
    )
    expect(readDownload({ name: 'a.xlsx', bytes: last }).text?.endsWith('\tИмя')).toBe(true)
  })

  it('refuses an entry that unpacks past the size its directory names (a zip bomb)', () => {
    const bytes = Buffer.from(
      zip(workbook('<worksheet><sheetData>' + '<row/>'.repeat(5000) + '</sheetData></worksheet>')),
    )
    // Understate the size of every entry in the central directory: unpacking past it fails.
    for (let at = bytes.length - 22; at >= 0; at--)
      if (bytes.readUInt32LE(at) === 0x02014b50) bytes.writeUInt32LE(1, at + 24)
    expect(readDownload({ name: 'a.xlsx', bytes })).toEqual({ kind: 'failed', text: null })
  })

  it('builds no more of a workbook than the agent may read of a file', () => {
    const row = '<row><c t="inlineStr"><is><t>' + 'я'.repeat(1000) + '</t></is></c></row>'
    const bytes = zip(
      workbook('<worksheet><sheetData>' + row.repeat(5000) + '</sheetData></worksheet>'),
    )
    const { text } = readDownload({ name: 'a.xlsx', bytes })
    expect(text!.length).toBeLessThanOrEqual(browserDownloadLimits.textChars + 1001)
    expect(text!.split('\n').length).toBeLessThan(5000)
  })

  it('tells the kind by the name and the first bytes alone', () => {
    expect(downloadKindOf({ name: 'x', bytes: zip({ a: 'b' }) })).toBe('workbook')
    expect(downloadKindOf({ name: 'Заявки.CSV', bytes: Buffer.from('a') })).toBe('text')
    expect(downloadKindOf({ name: 'scan.pdf', bytes: Buffer.from('%PDF') })).toBe('binary')
  })
})
