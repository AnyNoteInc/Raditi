// Puts the spike's results into the repository — only through the sanitiser of G0.
//   node collect.mjs            (SPIKE_OUT as for spike.mjs; run from anywhere)
// 1. picks the files named below out of $SPIKE_OUT into $SPIKE_OUT/staging/samples/<record>/…; every file
//    of samples/ is JSON, so the CLI's output becomes `{ events: [...] }` (its JSON lines, parsed), a plain
//    text becomes `{ text }` and the fake's records of a run become their digest (records-digest.mjs: the
//    requests without bodies, and what the tools answered) under a name ending in `.requests.json`;
// 2. refuses when anything picked holds a string shaped like a turn key or an MCP token of the stand
//    (the runs themselves search for the real values; this is the same question asked by shape);
// 3. runs `infra/dev/llm-verify/sanitize-samples.mjs copy` from the staging directory into
//    docs/research/2026-10-opencode-glm and then `check` over what was written.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORMS } from './p4.mjs'
import { outRoot } from './lib.mjs'
import { digestRecords } from './records-digest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESEARCH = resolve(HERE, '../..')
const REPO = resolve(RESEARCH, '../../..')
const SANITIZER = join(REPO, 'infra/dev/llm-verify/sanitize-samples.mjs')
const out = outRoot()
const stage = join(out, 'staging')
const RUNTIMES = ['runc', 'runsc']

/** record directory → [source below $SPIKE_OUT, name in the record]; the name's ending picks the form. */
const PICK = {
  '70-g1-runtime': [
    ...RUNTIMES.flatMap((rt) =>
      ['p1', 'p1crash', 'p2', 'p2ports'].map((point) => [
        `${rt}/${point}.json`,
        `${rt}.${point}.json`,
      ]),
    ),
    ['runsc/p1-crash-default/turn.stderr.txt', 'runsc.crash-default.stderr.text.json'],
    ['runsc/p2-fifo/first.records.json', 'runsc.full-turn.records.json'],
    ['runsc/p2-fifo/first.stdout.txt', 'runsc.full-turn.events.json'],
    ['runsc/p2-fifo-next/second.stdout.txt', 'runsc.continuation.events.json'],
    ['runsc/p2-missing-file/turn.stderr.txt', 'runsc.config-error.stderr.text.json'],
  ],
  '71-g1-hostile-db': [
    ...RUNTIMES.flatMap((rt) => [
      [`${rt}/p3.json`, `${rt}.p3.json`],
      [`${rt}/p3.sink.json`, `${rt}.p3.sink.json`],
    ]),
    // The turn with the planted directory prints no event: what its tools did is only in the requests.
    ['runsc/p3-row-directory/records.json', 'runsc.row-directory.requests.json'],
  ],
  '72-g1-refusals': [
    ...RUNTIMES.map((rt) => [`${rt}/p4.json`, `${rt}.p4.json`]),
    ...Object.keys(FORMS).flatMap((form) => [
      [`runsc/p4-${form}/turn.stdout.txt`, `events/${form}.events.json`],
      [`runsc/p4-${form}/records.json`, `requests/${form}.requests.json`],
    ]),
  ],
  '73-g1-mcp': [
    ...RUNTIMES.map((rt) => [`${rt}/p6.json`, `${rt}.p6.json`]),
    ['runsc/p6-refused-401/turn.stderr.txt', 'runsc.refused-401.stderr.text.json'],
    [
      'runsc/p6-refused-401-print-logs-info/turn.stderr.txt',
      'runsc.refused-401.print-logs.stderr.text.json',
    ],
  ],
  '74-g1-config': [
    ...RUNTIMES.map((rt) => [`${rt}/p7.json`, `${rt}.p7.json`]),
    ...RUNTIMES.map((rt) => [`${rt}/p7order.json`, `${rt}.p7order.json`]),
    ['runsc/p7-compaction-auto/records.json', 'runsc.compaction.records.json'],
    ['runsc/p7-compaction-auto/turn.stdout.txt', 'runsc.compaction.events.json'],
    ['runsc/p7-ask-without-flag/turn.stdout.txt', 'runsc.ask-without-flag.events.json'],
    ['runsc/p7-ask-without-flag/turn.stderr.txt', 'runsc.ask-without-flag.stderr.text.json'],
  ],
  '75-g1-binary': readdirSync(join(out, 'strings')).map((name) => [
    `strings/${name}`,
    name.replace(/\.txt$/, '.text.json'),
  ]),
}
/** The CLI's stdout: one JSON object per line. */
function events(text) {
  const parsed = []
  const unparsed = []
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      unparsed.push(line)
    }
  }
  return { events: parsed, ...(unparsed.length ? { unparsed } : {}) }
}

rmSync(stage, { recursive: true, force: true })
const entries = []
const missing = []
for (const [record, files] of Object.entries(PICK)) {
  for (const [source, name] of files) {
    const from = join(out, source)
    if (!existsSync(from)) {
      missing.push(source)
      continue
    }
    const to = join(stage, 'samples', record, name)
    mkdirSync(dirname(to), { recursive: true })
    if (name.endsWith('.events.json'))
      writeFileSync(to, JSON.stringify(events(readFileSync(from, 'utf8'))))
    else if (name.endsWith('.requests.json'))
      writeFileSync(
        to,
        JSON.stringify({ source, ...digestRecords(JSON.parse(readFileSync(from, 'utf8'))) }),
      )
    else if (name.endsWith('.text.json'))
      writeFileSync(to, JSON.stringify({ source, text: readFileSync(from, 'utf8') }))
    else cpSync(from, to)
  }
  if (existsSync(join(stage, 'samples', record))) entries.push(`samples/${record}`)
}
if (missing.length) console.log(`not there (skipped): ${missing.join(', ')}`)

const SHAPES = /sk-rdt-[A-Za-z0-9_-]{43}|mcp_[0-9a-f]{64}/g
const shaped = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else
      for (const match of readFileSync(path, 'latin1').matchAll(SHAPES))
        shaped.push(`${path}: ${match[0].slice(0, 8)}… (${match[0].length} chars)`)
  }
}
walk(stage)
if (shaped.length) {
  console.error(
    `credential-shaped strings in the picked files, nothing copied:\n${shaped.join('\n')}`,
  )
  process.exit(1)
}

for (const record of Object.keys(PICK))
  rmSync(join(RESEARCH, 'samples', record), { recursive: true, force: true })
const node = process.execPath
execFileSync(node, [SANITIZER, 'copy', '--from', stage, '--to', RESEARCH, ...entries], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
execFileSync(node, [SANITIZER, 'check', ...entries.map((entry) => join(RESEARCH, entry))], {
  stdio: 'inherit',
})
console.log(`copied: ${entries.join(', ')}`)
