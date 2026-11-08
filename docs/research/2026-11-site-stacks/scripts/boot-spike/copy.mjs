// copy.mjs <policy.json> <prefix> <port> <out.sql> [charset] [collation]: the REAL copier of the product against the synthetic production.
import { createWriteStream, readFileSync } from 'node:fs'
import { once } from 'node:events'
const R = '<repo>'
const { createMysqlDatabaseCopier } = await import(`${R}/packages/site-connections/src/database-copy/mysql-copier.ts`)
const [policyFile, tablePrefix, port, out, charset = 'utf8mb4', collation = ''] = process.argv.slice(2)
const policy = JSON.parse(readFileSync(policyFile, 'utf8'))
const copier = createMysqlDatabaseCopier({ appEnv: 'development', lookup: async () => ['127.0.0.1'] })
const file = createWriteStream(out)
const started = Date.now()
try {
  const summary = await copier.copy({
    access: { v: '1', engine: 'mysql', host: '127.0.0.1', port: String(port), tls: 'plain', database: 'site', username: 'site', password: '<hidden>' },
    tablePrefix, charset, collation: collation || null, policy,
  }, async (chunk) => { if (!file.write(chunk)) await once(file, 'drain') })
  file.end(); await once(file, 'finish')
  console.log(JSON.stringify({ ...summary, ms: Date.now() - started, policyTables: policy.tables.length }))
} catch (error) {
  console.error('COPY FAILED', error?.name, error?.reason ?? '', error?.code ?? '', error?.message)
  process.exitCode = 2
}
