import { badRequest, type DatabaseEngine, type DatabaseInspector } from '@repo/domain'

import { mysqlInspector } from './mysql.ts'
import { postgresInspector } from './postgres.ts'

export { mysqlInspector } from './mysql.ts'
export { postgresInspector } from './postgres.ts'

/** A lookup table: the transport and the worker index the inspectors by engine and never compare one. */
const inspectors: Record<DatabaseEngine, DatabaseInspector> = {
  mysql: mysqlInspector,
  postgres: postgresInspector,
}

export function databaseInspector(engine: DatabaseEngine): DatabaseInspector {
  const inspector = Object.hasOwn(inspectors, engine) ? inspectors[engine] : undefined
  if (!inspector) throw badRequest('Unknown database engine')
  return inspector
}
