-- The trusted host returns content edits under the fence of a site lease, without a turn key
-- (spec §11): the undo before a replaced turn, the undo of a turn that did not complete and
-- «Отменить» of a finished task. Such a call has no assignment and no key: it names the task
-- that holds the lease and the lease operation, and it is always a restore.
--
-- No row is changed. The new columns are NULL in every existing row, and each replaced CHECK
-- accepts everything its predecessor accepted: a row from before the journal, a call of the
-- agent, the write barrier of a turn. A CHECK passes on UNKNOWN, so every comparison of a
-- nullable column stands next to its IS NOT NULL.
--
-- One transaction: Prisma sends a migration statement by statement, and a constraint dropped
-- here must never be left without the one that replaces it.
BEGIN;

ALTER TABLE "mcp_calls"
  ADD COLUMN "host_task_id" UUID,
  ADD COLUMN "host_operation" "LeaseOperation";

CREATE INDEX "mcp_calls_host_task_id_idx" ON "mcp_calls"("host_task_id");
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_host_task_id_fkey"
  FOREIGN KEY ("host_task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Three shapes of a row, and nothing between them.
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_managed_binding_check";
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_managed_binding_check" CHECK (
  -- Written before the journal: no owner and no journal field.
  ("assignment_id" IS NULL AND "credential_key_id" IS NULL
    AND "host_task_id" IS NULL AND "host_operation" IS NULL
    AND "request_hash" IS NULL AND "lease_epoch" IS NULL AND "write_started_at" IS NULL)
  -- A call of the agent: its assignment and its turn key, never a host owner.
  OR ("assignment_id" IS NOT NULL AND "credential_key_id" IS NOT NULL
    AND "host_task_id" IS NULL AND "host_operation" IS NULL
    AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
  -- A call of the trusted host: the holder of the site lease and its operation, never an
  -- assignment or a key, and only a restore.
  OR ("assignment_id" IS NULL AND "credential_key_id" IS NULL
    AND "host_task_id" IS NOT NULL AND "host_operation" IS NOT NULL
    AND "host_operation" IN ('turn'::"LeaseOperation", 'revert'::"LeaseOperation")
    AND "tool" = 'restore' AND "restores_snapshot_id" IS NOT NULL
    AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
);

-- The result rules of a managed call cover the calls of the host too.
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_managed_result_check";
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_managed_result_check" CHECK (
  ("assignment_id" IS NULL AND "host_task_id" IS NULL) OR (
    (("result" IS NULL AND "finished_at" IS NULL) OR ("result" IS NOT NULL AND "finished_at" IS NOT NULL))
    AND ("result" IS DISTINCT FROM 'ok'::"McpCallResult" OR "write_started_at" IS NOT NULL)
    AND ("result" IS NULL OR "response" IS NOT NULL)
  )
);

-- A restore belongs to an assignment or to the host.
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_content_restore_check";
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_content_restore_check" CHECK (
  "restores_snapshot_id" IS NULL OR
  ("tool" = 'restore' AND ("assignment_id" IS NOT NULL OR "host_task_id" IS NOT NULL)
    AND "snapshot_id" IS NOT NULL AND "snapshot_id" <> "restores_snapshot_id")
);

-- An unconfirmed content write holds a site leased for a turn or for a revert.
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_mcp_barrier_check";
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_mcp_barrier_check" CHECK (
  "inflight_mcp_call_id" IS NULL OR ("holder_task_id" IS NOT NULL AND "operation" IS NOT NULL
    AND "operation" IN ('turn'::"LeaseOperation", 'revert'::"LeaseOperation"))
);

COMMIT;
