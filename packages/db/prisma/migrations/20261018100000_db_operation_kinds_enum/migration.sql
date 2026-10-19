-- The kinds of a database plan beyond the text of a record (docs/plan/53-chat-preview-release.md,
-- «Операции БД и миграции»): a setting of the closed list, a created record, a table of the
-- platform — and, in the journal of a preview alone, the trash of a record the plan created.
-- No row is changed.
--
-- Alone in its migration: PostgreSQL refuses to use a new enum value in the transaction that
-- added it, and the CHECK constraints of the next migration name them.
ALTER TYPE "DbOperationKind" ADD VALUE 'option_update';
ALTER TYPE "DbOperationKind" ADD VALUE 'post_create';
ALTER TYPE "DbOperationKind" ADD VALUE 'schema_migration';
ALTER TYPE "DbOperationKind" ADD VALUE 'post_trash';
