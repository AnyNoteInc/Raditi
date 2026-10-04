-- A retired account keeps its row: llm_keys, llm_calls, token_usage and task_account_bindings
-- reference it with RESTRICT. It must not reserve its label or provider account for ever, or
-- the same subscription could never return to the pool. Uniqueness now covers only accounts
-- that are not retired; no row is changed.
DROP INDEX "subscription_accounts_label_key";
DROP INDEX "subscription_accounts_external_key";
CREATE UNIQUE INDEX "subscription_accounts_label_key"
  ON "subscription_accounts"("label") WHERE "status" <> 'retired';
CREATE UNIQUE INDEX "subscription_accounts_external_key"
  ON "subscription_accounts"("provider_id", "external_account_id") WHERE "status" <> 'retired';

-- Note on 20260929130000_subscription_gateway, which created these indexes: the GRANT/REVOKE
-- block at its end is historical. The roles it names (raditi_app, raditi_core, raditi_llm) were
-- cancelled on 30.09.2026 and every service connects as the owner raditi. The block finds no
-- such role and does nothing; were one restored from an old dump, the next bootstrap run
-- (infra/app/postgres/init-roles.sh, infra/dev/postgres-init.sql) drops it together with
-- whatever the block granted. It stays because an applied migration is never edited; no
-- privilege model follows from its comment.
