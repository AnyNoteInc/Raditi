// Inside the CLI container, after a turn: what the CLI left behind.
// stdin: { needles: { label: value }, roots: [dir], db: path }
// stdout: { files, hits, secretsDir, db: { tables, session, sizes } } — a hit names the file and the form
// (raw, json, base64…), never the value. Every regular file under the roots is read whole.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findNeedles } from '../needles.mjs'

const input = JSON.parse(readFileSync(0, 'utf8'))
const roots = input.roots ?? ['/agent-home', '/tmp', '/workspace', '/run/raditi']
const dbPath = input.db ?? '/agent-home/opencode/.local/share/opencode/opencode.db'
const out = { files: [], hits: [], unreadable: [], db: undefined }

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch (error) {
    out.unreadable.push({ path: dir, error: error.code })
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      walk(path)
      continue
    }
    const type = stat.isFile()
      ? 'file'
      : stat.isFIFO()
        ? 'fifo'
        : stat.isSymbolicLink()
          ? 'link'
          : 'other'
    // The repository's own objects are not the CLI's writing; they are still searched below.
    if (!path.includes('/.git/'))
      out.files.push({ path, size: stat.size, type, mode: (stat.mode & 0o777).toString(8) })
    if (type !== 'file') continue
    try {
      for (const hit of findNeedles(readFileSync(path), input.needles ?? {}))
        out.hits.push({ ...hit, path })
    } catch (error) {
      out.unreadable.push({ path, error: error.code })
    }
  }
}
for (const root of roots) if (existsSync(root)) walk(root)
out.files.sort((a, b) => a.path.localeCompare(b.path))

if (existsSync(dbPath)) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name)
    out.db = { tables: {}, sessions: [] }
    for (const table of tables)
      out.db.tables[table] = db.prepare(`select count(*) as n from "${table}"`).get().n
    out.db.sessions = db
      .prepare(
        'select id, title, agent, model, permission, directory, project_id, tokens_input, tokens_output, time_compacting from session order by time_created',
      )
      .all()
    out.db.messages = db
      .prepare('select session_id, count(*) as n from message group by session_id')
      .all()
    db.close()
  } catch (error) {
    out.db = { error: `${error.code ?? ''} ${error.message}` }
  }
}
console.log(JSON.stringify(out))
