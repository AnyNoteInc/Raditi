/**
 * Tab-separated text as Excel and Google Sheets put it on the clipboard: rows end with CRLF or LF
 * (Excel adds one at the very end), a cell with a tab, a line break or a quote is wrapped in
 * quotes with inner quotes doubled. A quote that does not open a cell is just a character.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  const n = text.length
  let atCellStart = true
  while (i < n) {
    const ch = text[i] as string
    if (atCellStart && ch === '"') {
      // A quoted cell: find the closing quote that is followed by a tab, a line break or the end.
      let j = i + 1
      let value = ''
      let closed = false
      while (j < n) {
        const c = text[j] as string
        if (c === '"') {
          if (text[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          const after = text[j + 1]
          if (after === undefined || after === '\t' || after === '\n' || after === '\r') {
            closed = true
            j += 1
            break
          }
          value += '"'
          j += 1
          continue
        }
        value += c
        j += 1
      }
      if (closed) {
        cell = value
        i = j
        atCellStart = false
        continue
      }
      // An unclosed quote: the cell is literal text.
    }
    atCellStart = false
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      atCellStart = true
      i += 1
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      cell += ch
      i += 1
    }
  }
  if (!atCellStart || cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function quote(cell: string): string {
  return /[\t\r\n"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

/** The clipboard form of a range: the same rules Excel and Google Sheets read back. */
export function toTsv(matrix: string[][]): string {
  return matrix.map((row) => row.map(quote).join('\t')).join('\r\n')
}
