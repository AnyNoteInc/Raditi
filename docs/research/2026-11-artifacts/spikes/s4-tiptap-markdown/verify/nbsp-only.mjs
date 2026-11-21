// Of the corpus documents whose reader text @tiptap/markdown changes, in how many is it only the
// no-break spaces (the real doc-render text with U+00A0, U+202F and U+2009 read as a space)?
import { readFileSync } from 'node:fs'
import { seen } from './canon.mjs'
const results = JSON.parse(readFileSync(new URL('../results/corpus.json', import.meta.url)))
const flat = (s) => s.replace(/[   ]/g, ' ')
let w = 0, only = []
for (const d of results) {
  const r = d.whole['tiptap·stock·plan']
  if (seen(r.a) === seen(r.c)) continue
  w += 1
  if (flat(seen(r.a)) === flat(seen(r.c))) only.push(d.name)
}
console.log({ readerTextChanged: w, onlyNoBreakSpaces: only.length }, only.join(' '))
