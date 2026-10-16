-- The product moves to one shell and one model: OpenCode with GLM on the Z.ai coding plan
-- (owner's decision of 04.10.2026). The earlier shells, their providers, models and accounts are
-- switched off here and the driver of the new shell is switched on. Only `enabled` flags are
-- written: every row, rate, key, call and usage record stays as history.
--
-- Not switched on here: the provider zai-coding, its three profiles and an accounting rate. The
-- operator does that (docs/plan/48-removal.md); without an approved rate no turn key is issued.

-- Stop instead of orphaning what the code after the removal can no longer serve. After a stop
-- Prisma records the migration as failed: once the cause is gone, `prisma migrate resolve
-- --rolled-back` lets the next deploy apply it.
--
-- The checks stand before BEGIN on purpose. Prisma sends this file as one query and, when it
-- fails, writes the error into its own table on the same connection. An exception raised inside
-- an explicit transaction block leaves that connection in the failed block, Prisma's write then
-- fails too, and the operator reads «current transaction is aborted» instead of the message
-- below (measured with Prisma 7.10). Raised here, the exception ends the query with nothing
-- changed and the message reaches the operator.
DO $$
DECLARE
  total integer;
  ids text;
BEGIN
  -- A credential that is still valid at the provider: after the removal no command of the
  -- platform can revoke it or destroy its secret in Vault.
  SELECT count(*), string_agg(live."id"::text, ', ' ORDER BY live."id") FILTER (WHERE live."n" <= 20)
    INTO total, ids
    FROM (
      SELECT a."id", row_number() OVER (ORDER BY a."id") AS "n"
        FROM "subscription_accounts" a
        JOIN "llm_providers" p ON p."id" = a."provider_id"
       WHERE p."slug" IN ('openai-chatgpt', 'kimi-code')
         AND a."credential_version" > 0 AND a."status" <> 'retired'
    ) live;
  IF total > 0 THEN
    RAISE EXCEPTION 'switch_to_opencode stopped, nothing was changed: % subscription account(s) of openai-chatgpt or kimi-code still hold a credential and are not retired (at most 20 ids shown): %. Retire each of them first (docs/plan/48-removal.md), then run "prisma migrate resolve --rolled-back 20261011090000_switch_to_opencode" and deploy again.', total, ids;
  END IF;

  -- Work the removed shells have not finished. The saved turn plan, the pool binding and the
  -- turn key of such a task name a driver the code will no longer know, so the task could not
  -- go on; and recovery reads the plan of every open turn assignment, whatever its task's status.
  SELECT count(*), string_agg(unfinished."id"::text, ', ' ORDER BY unfinished."id") FILTER (WHERE unfinished."n" <= 20)
    INTO total, ids
    FROM (
      SELECT t."id", row_number() OVER (ORDER BY t."id") AS "n"
        FROM "tasks" t
       WHERE (
           t."status" NOT IN ('done', 'failed', 'rolled_back', 'cancelled')
           AND (
             EXISTS (SELECT 1 FROM "task_turns" x
                      WHERE x."task_id" = t."id" AND x."driver_id" IN ('codex', 'kimi', 'qwen'))
             OR EXISTS (SELECT 1 FROM "turn_assignments" x
                         WHERE x."task_id" = t."id" AND x."plan"->>'driverId' IN ('codex', 'kimi', 'qwen'))
             OR EXISTS (SELECT 1 FROM "task_account_bindings" x
                         WHERE x."task_id" = t."id" AND x."driver_id" IN ('codex', 'kimi', 'qwen'))
             OR EXISTS (SELECT 1 FROM "llm_keys" x
                         WHERE x."task_id" = t."id" AND x."driver_id" IN ('codex', 'kimi', 'qwen'))
           )
         )
         OR EXISTS (SELECT 1 FROM "turn_assignments" x
                     WHERE x."task_id" = t."id" AND x."finished_at" IS NULL
                       AND x."plan"->>'driverId' IN ('codex', 'kimi', 'qwen'))
    ) unfinished;
  IF total > 0 THEN
    RAISE EXCEPTION 'switch_to_opencode stopped, nothing was changed: % unfinished task(s) have a turn, a turn assignment, a pool binding or a turn key of codex, kimi or qwen, or an open turn assignment of one (at most 20 ids shown): %. Finish or cancel them first (docs/plan/48-removal.md), then run "prisma migrate resolve --rolled-back 20261011090000_switch_to_opencode" and deploy again.', total, ids;
  END IF;
END $$;

-- One transaction for the switch itself: the flags change together or not at all, whether the
-- file arrives as one query or statement by statement.
BEGIN;

UPDATE "agent_drivers" SET "enabled" = false WHERE "id" IN ('codex', 'kimi', 'qwen');
UPDATE "agent_drivers" SET "enabled" = true WHERE "id" = 'opencode';

UPDATE "llm_providers" SET "enabled" = false WHERE "slug" IN ('openai-chatgpt', 'kimi-code');
UPDATE "llm_models" SET "enabled" = false
 WHERE "provider_id" IN (SELECT "id" FROM "llm_providers" WHERE "slug" IN ('openai-chatgpt', 'kimi-code'));
UPDATE "subscription_accounts" SET "enabled" = false
 WHERE "provider_id" IN (SELECT "id" FROM "llm_providers" WHERE "slug" IN ('openai-chatgpt', 'kimi-code'));

COMMIT;
