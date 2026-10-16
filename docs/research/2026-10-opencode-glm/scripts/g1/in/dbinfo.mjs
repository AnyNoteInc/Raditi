// Inside the CLI container: the schema of the CLI's database and the rows of its small tables.
//   node dbinfo.mjs [database path]
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(
  process.argv[2] ?? '/agent-home/opencode/.local/share/opencode/opencode.db',
  { readOnly: true },
)
const tables = db
  .prepare("select name, sql from sqlite_master where type = 'table' order by name")
  .all()
const out = {}
for (const { name, sql } of tables) {
  const count = db.prepare(`select count(*) as n from "${name}"`).get().n
  out[name] = {
    sql,
    count,
    rows:
      count > 0 && count <= 3 && !['migration', 'event', 'part', 'message'].includes(name)
        ? db.prepare(`select * from "${name}"`).all()
        : undefined,
  }
}
console.log(JSON.stringify(out, null, 1))
