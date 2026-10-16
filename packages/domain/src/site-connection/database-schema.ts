import { z } from 'zod'

import { hasControlCharacter } from './inputs.ts'
import { databaseEngines } from './kinds.ts'
import { databaseSchemaLimits } from './limits.ts'

// The structure of a client's database as the platform stores it (site_database_schemas.schema).
// Never read and never stored: rows of any user table, row counts or estimates, table and column
// comments, default and generation expressions, enum value lists, view and index definitions,
// check constraints, triggers, routines, grants. The document is named DatabaseStructure:
// `SiteDatabaseSchema` is the Prisma row.

const identifier = z
  .string()
  .min(1)
  .max(databaseSchemaLimits.identifierChars)
  .refine((value) => !hasControlCharacter(value))

export const databaseStructureSchema = z.strictObject({
  v: z.literal(1),
  engine: z.enum(databaseEngines),
  tables: z
    .array(
      z.strictObject({
        /** PostgreSQL namespace; null for MySQL. */
        schema: identifier.nullable(),
        name: identifier,
        kind: z.enum(['table', 'view', 'materialized_view', 'partitioned_table', 'foreign_table']),
        columns: z.array(
          z.strictObject({
            name: identifier,
            /** A type name with length or precision ("varchar(255)", "numeric(10,2)"). Never enum values. */
            type: z.string().min(1).max(databaseSchemaLimits.typeChars),
            nullable: z.boolean(),
            hasDefault: z.boolean(),
            generated: z.boolean(),
            autoIncrement: z.boolean(),
          }),
        ),
        primaryKey: z.array(identifier),
        indexes: z.array(
          z.strictObject({
            name: identifier,
            unique: z.boolean(),
            /** null stands for an expression: its text is not stored. */
            columns: z.array(identifier.nullable()),
          }),
        ),
        foreignKeys: z.array(
          z.strictObject({
            name: identifier,
            columns: z.array(identifier),
            referencedSchema: identifier.nullable(),
            referencedTable: identifier,
            referencedColumns: z.array(identifier),
          }),
        ),
      }),
    )
    .max(databaseSchemaLimits.tables),
  /** A ceiling was reached, or a table was dropped for a name that is too long or holds a control character. */
  truncated: z.boolean(),
})
export type DatabaseStructure = z.infer<typeof databaseStructureSchema>
