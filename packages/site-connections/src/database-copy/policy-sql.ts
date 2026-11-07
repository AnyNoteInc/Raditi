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

/** The columns the overrides of `table` set or match: the platform's own state in the copy. */
export function overrideColumns(policy: DatabaseCopyPolicy, table: string): string[] {
  const named = new Set<string>()
  for (const override of policy.overrides)
    if (override.table === table) {
      named.add(override.match.column)
      for (const column of Object.keys(override.set ?? {})) named.add(column)
    }
  return [...named]
}

/**
 * Every column the policy names in `table`: the conditions and treatments of its rule, the keys
 * other rules follow, its overrides. MySQL finds a column whatever the case of its name, the
 * copy matches names exactly: one of these present under another case is refused, so a
 * treatment never misses a column the site still has.
 */
export function namedColumns(policy: DatabaseCopyPolicy, table: string): string[] {
  const rule = policy.tables.find((candidate) => candidate.table === table)
  const named = new Set<string>(overrideColumns(policy, table))
  for (const condition of rule?.where ?? []) named.add(condition.column)
  for (const column of Object.keys(rule?.columns ?? {})) named.add(column)
  for (const other of policy.tables)
    for (const condition of other.where)
      if (condition.op === 'inCopied' && condition.table === table) named.add(condition.key)
  return [...named]
}

/**
 * Tables of the policy the copy writes as structure only: a rule with a condition on a column
 * its table lacks, and every rule that follows such a table or a key its target lacks. A
 * condition dropped without its table would copy every row, so the rule goes whole. A column
 * only a treatment names is not here: that treatment has nothing to apply to. `columnsOf`
 * answers null for a table the source lacks: `rowFilter` already makes that `FALSE`. `taken` —
 * tables the copy writes as structure only for its own reason, followed the same way.
 */
export function rulesWithoutRows(
  policy: DatabaseCopyPolicy,
  columnsOf: (table: string) => ReadonlySet<string> | null,
  taken: Iterable<string> = [],
): Set<string> {
  const emptied = new Set<string>(taken)
  const lacks = (table: string, column: string) => {
    const columns = columnsOf(table)
    return columns !== null && !columns.has(column)
  }
  const goes = (rule: Rule) =>
    rule.where.some((condition) =>
      condition.op === 'inCopied'
        ? lacks(rule.table, condition.column) ||
          emptied.has(condition.table) ||
          lacks(condition.table, condition.key)
        : lacks(rule.table, condition.column),
    )
  // A fixed point: a rule taken out takes out the rules that follow it.
  for (let changed = true; changed;) {
    changed = false
    for (const rule of policy.tables)
      if (!emptied.has(rule.table) && goes(rule)) {
        emptied.add(rule.table)
        changed = true
      }
  }
  return emptied
}
