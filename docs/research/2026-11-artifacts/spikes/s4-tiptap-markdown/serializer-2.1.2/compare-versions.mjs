// The canonical text depends on the exact serializer: the same corpus through mdast-util-to-markdown
// 2.1.2 (what the repository's lockfile holds today) and 2.2.3 (the harness).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
const [corpusDir, outFile] = process.argv.slice(2)
const STRINGIFY = { bullet: '-', bulletOther: '*', bulletOrdered: '.', emphasis: '*', strong: '*', fence: '`', fences: true, rule: '-', ruleRepetition: 3, listItemIndent: 'one', incrementListMarker: true, setext: false, closeAtx: false, resourceLink: false, quote: '"' }
const GFM = { tablePipeAlign: false, tableCellPadding: true }
const canon = (md) => unified().use(remarkParse).use(remarkGfm, GFM).use(remarkStringify, STRINGIFY).processSync(md).toString()
const decode = (s) => s.replace(/⍽/g, ' ').replace(/⎵/g, ' ')
const out = {}
for (const f of readdirSync(corpusDir).filter((f) => f.endsWith('.md')).sort()) out[f] = canon(decode(readFileSync(corpusDir + '/' + f, 'utf8')))
writeFileSync(outFile, JSON.stringify(out))
