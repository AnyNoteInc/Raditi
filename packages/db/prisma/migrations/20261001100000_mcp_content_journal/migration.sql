-- Nullable additions preserve historical calls and snapshots. The new journal never admits
-- a legacy row as a managed call; old in-flight work must be reconciled separately.
ALTER TABLE "mcp_calls"
  ADD COLUMN "assignment_id" UUID,
  ADD COLUMN "credential_key_id" UUID,
  ADD COLUMN "request_hash" VARCHAR(64),
  ADD COLUMN "lease_epoch" INTEGER,
  ADD COLUMN "write_started_at" TIMESTAMPTZ(6);

ALTER TABLE "snapshots"
  ADD COLUMN "payload_sha256" VARCHAR(64),
  ADD COLUMN "size_bytes" INTEGER;

ALTER TABLE "site_leases" ADD COLUMN "inflight_mcp_call_id" UUID;

CREATE INDEX "mcp_calls_assignment_id_idx" ON "mcp_calls"("assignment_id");
CREATE UNIQUE INDEX "site_leases_inflight_mcp_call_id_key" ON "site_leases"("inflight_mcp_call_id");

ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "turn_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_inflight_mcp_call_id_fkey"
  FOREIGN KEY ("inflight_mcp_call_id") REFERENCES "mcp_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_managed_binding_check" CHECK (
  ("assignment_id" IS NULL AND "credential_key_id" IS NULL AND "request_hash" IS NULL AND "lease_epoch" IS NULL AND "write_started_at" IS NULL)
  OR ("assignment_id" IS NOT NULL AND "request_hash" IS NOT NULL
    AND "credential_key_id" IS NOT NULL
    AND "request_hash" ~ '^[0-9a-f]{64}$' AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
);
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_managed_result_check" CHECK (
  "assignment_id" IS NULL OR (
    (("result" IS NULL AND "finished_at" IS NULL) OR ("result" IS NOT NULL AND "finished_at" IS NOT NULL))
    AND ("result" IS DISTINCT FROM 'ok'::"McpCallResult" OR "write_started_at" IS NOT NULL)
    AND ("result" IS NULL OR "response" IS NOT NULL)
  )
);
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_payload_check" CHECK (
  ("payload_sha256" IS NULL AND "size_bytes" IS NULL)
  OR ("payload_sha256" IS NOT NULL AND "payload_sha256" ~ '^[0-9a-f]{64}$'
    AND "size_bytes" IS NOT NULL AND "size_bytes" BETWEEN 1 AND 65536)
);
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_mcp_barrier_check" CHECK (
  "inflight_mcp_call_id" IS NULL OR ("holder_task_id" IS NOT NULL AND "operation" = 'turn'::"LeaseOperation")
);
