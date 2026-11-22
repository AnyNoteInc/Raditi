-- The storage of an organiser of distribution of information (149-FZ, art. 10.1; plan 88, Ар56,
-- slice 88.16а-1); additive. Facts — 3 years after the action ends (Government Decree № 1526,
-- p. 3, 15); messages of shared artifacts in full — 6 months (Decree № 256, p. 3). No foreign
-- keys to users or artifacts: both outlive a deleted account and a purged artifact. Append only:
-- a trigger refuses UPDATE and DELETE, except a DELETE of rows past their term by the collector,
-- which says so with the setting `raditi.ori_sweep` of its transaction.
BEGIN;
CREATE TABLE "ori_facts" (
  "id" BIGSERIAL NOT NULL,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "kind" VARCHAR(24) NOT NULL,
  "user_id" UUID,
  "ip" INET,
  "port" INTEGER,
  "artifact_id" UUID,
  "addressees" UUID[] NOT NULL DEFAULT '{}',
  "detail" JSONB NOT NULL DEFAULT '{}',
  "keep_until" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ori_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ori_facts_check" CHECK (
    "kind" IN ('register', 'sign_in', 'email_change', 'account_deleted', 'payment',
               'access_open', 'access_grant', 'artifact_write', 'artifact_comment')
    AND ("port" IS NULL OR "port" BETWEEN 0 AND 65535)
  )
);
CREATE INDEX "ori_facts_user_id_at_idx" ON "ori_facts"("user_id", "at");
CREATE INDEX "ori_facts_artifact_id_at_idx" ON "ori_facts"("artifact_id", "at")
  WHERE "artifact_id" IS NOT NULL;
CREATE INDEX "ori_facts_keep_until_idx" ON "ori_facts"("keep_until");

CREATE TABLE "ori_messages" (
  "id" BIGSERIAL NOT NULL,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "artifact_id" UUID NOT NULL,
  "user_id" UUID,
  "task_id" UUID,
  "block_key" VARCHAR(40),
  "kind" VARCHAR(16) NOT NULL,
  "content" TEXT,
  "addressees" UUID[] NOT NULL DEFAULT '{}',
  "keep_until" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ori_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ori_messages_check" CHECK ("kind" IN ('write', 'delete', 'comment', 'purge'))
);
CREATE INDEX "ori_messages_artifact_id_at_idx" ON "ori_messages"("artifact_id", "at");
CREATE INDEX "ori_messages_user_id_at_idx" ON "ori_messages"("user_id", "at");
CREATE INDEX "ori_messages_keep_until_idx" ON "ori_messages"("keep_until");

CREATE FUNCTION "ori_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('raditi.ori_sweep', true) = 'on'
     AND OLD.keep_until < now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the journal % is append only', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER "ori_facts_append_only" BEFORE UPDATE OR DELETE ON "ori_facts"
  FOR EACH ROW EXECUTE FUNCTION "ori_append_only"();
CREATE TRIGGER "ori_messages_append_only" BEFORE UPDATE OR DELETE ON "ori_messages"
  FOR EACH ROW EXECUTE FUNCTION "ori_append_only"();
COMMIT;
