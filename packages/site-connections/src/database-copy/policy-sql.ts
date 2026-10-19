import type { DatabaseCopyCondition, DatabaseCopyPolicy } from '@repo/domain'
import { badRequest } from '@repo/domain'

// The rows of a copy policy as a WHERE of the source (docs/plan/53-chat-preview-release.md,
// Р15): every name and value is a placeholder of mysql2 (`??` and `?`), nothing is pasted in.
// A table outside the rules is never read, so an allow list stays an allow list.

export interface WhereClause {
  sql: string
  values: unknown[]
}

type Rule = DatabaseCopyPolicy['tables'][number]

/**
 * Refuses a policy no copy could follow: an `inCopied` of a table without a rule, or a chain of
 * them that comes back to itself. The schema has taken the shape already; these are mistakes of
 * the stack's adapter.
 */
export function assertCopyPolicy(policy: DatabaseCopyPolicy): void {
  const rules = new Map(policy.tables.map((rule) => [rule.table, rule]))
  const visit = (rule: Rule, path: readonly string[]) => {
    for (const condition of rule.where) {
      if (condition.op !== 'inCopied') continue
      const target = rules.get(condition.table)
      if (!target)
        throw badRequest(`Copy policy: ${rule.table} follows ${condition.table}, which has no rule`)
      if (path.includes(target.table))
        throw badRequest(`Copy policy: ${[...path, target.table].join(' → ')} is a cycle`)
      visit(target, [...path, target.table])
    }
  }
  for (const rule of policy.tables) visit(rule, [rule.table])
}

/**
 * The WHERE of the rows of `table` the copy holds. `tableName` puts the site's prefix on a
 * table of the policy, `exists` says whether the source has it: rows that must belong to a
 * table the source lacks belong to nothing (`FALSE`).
 */
export function rowFilter(
  policy: DatabaseCopyPolicy,
  table: string,
  tableName: (table: string) => string,
  exists: (table: string) => boolean,
): WhereClause {
  const rules = new Map(policy.tables.map((rule) => [rule.table, rule]))
  const rule = rules.get(table)
  if (!rule) throw badRequest(`Copy policy: ${table} has no rule`)

  const clause = (current: Rule): WhereClause => {
    const parts = current.where.map((condition) => conditionClause(condition))
    if (parts.length === 0) return { sql: 'TRUE', values: [] }
    return {
      sql: parts.map((part) => `(${part.sql})`).join(' AND '),
      values: parts.flatMap((part) => part.values),
    }
  }

  const conditionClause = (condition: DatabaseCopyCondition): WhereClause => {
    switch (condition.op) {
      case 'in':
        return { sql: '?? IN (?)', values: [condition.column, [...condition.values]] }
      case 'like':
        return {
          sql: condition.patterns.map(() => '?? LIKE ?').join(' OR '),
          values: condition.patterns.flatMap((pattern) => [condition.column, pattern]),
        }
      case 'notLike':
        return {
          sql: condition.patterns.map(() => '?? NOT LIKE ?').join(' AND '),
          values: condition.patterns.flatMap((pattern) => [condition.column, pattern]),
        }
      case 'inCopied': {
        const target = rules.get(condition.table)
        if (!target) throw badRequest(`Copy policy: ${condition.table} has no rule`)
        if (!exists(condition.table)) return { sql: 'FALSE', values: [] }
        const inner = clause(target)
        return {
          sql: `?? IN (SELECT ?? FROM ?? WHERE ${inner.sql})`,
          values: [condition.column, condition.key, tableName(condition.table), ...inner.values],
        }
      }
    }
  }

  return clause(rule)
}

/** Every column a rule of `table` names in that table: its conditions and its treatments. */
export function ruleColumns(policy: DatabaseCopyPolicy, table: string): string[] {
  const rule = policy.tables.find((candidate) => candidate.table === table)
  const named = new Set<string>()
  for (const condition of rule?.where ?? []) named.add(condition.column)
  for (const column of Object.keys(rule?.columns ?? {})) named.add(column)
  for (const other of policy.tables)
    for (const condition of other.where)
      if (condition.op === 'inCopied' && condition.table === table) named.add(condition.key)
  for (const override of policy.overrides)
    if (override.table === table) {
      named.add(override.match.column)
      for (const column of Object.keys(override.set ?? {})) named.add(column)
    }
  return [...named]
}
