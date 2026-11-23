-- Artifacts, release 1 (docs/plan/88-artifacts.md, Ар11, Ар13, Ар14, Ар16, Ар20, §7.1, slice 88.2).
-- The document of the agent becomes the kind «Документ» of an artifact in place: the tables
-- chat_documents* keep their names (Prisma models Artifact*), and this release only adds — new
-- columns with defaults, new tables, CHECKs relaxed, a trigger — so the code before it keeps
-- working while it applies (infra/server/deploy.sh). Release 2 (slice 88.30) sets owner_user_id
-- NOT NULL and drops position and markdown.
--
-- No stop: every row of the code before satisfies what is added. The backfills below are
-- repeatable — fillArtifactRows of @repo/db does the same for rows the code before writes while
-- the new one is rolled out.

BEGIN;

-- AlterTable
ALTER TABLE "chat_documents" ADD COLUMN     "bytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_by" VARCHAR(8),
ADD COLUMN     "kind" VARCHAR(24) NOT NULL DEFAULT 'document',
ADD COLUMN     "owner_user_id" UUID,
ADD COLUMN     "pending_task_id" UUID,
ADD COLUMN     "pending_title" VARCHAR(200),
ADD COLUMN     "pending_turn" INTEGER,
ADD COLUMN     "project_id" UUID,
ADD COLUMN     "purge_after" TIMESTAMPTZ(6),
ADD COLUMN     "recipients_copy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seq" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "taken_down_at" TIMESTAMPTZ(6),
ADD COLUMN     "taken_down_by" VARCHAR(8);

-- AlterTable
ALTER TABLE "chat_document_sections" ADD COLUMN     "block_kind" VARCHAR(16) NOT NULL DEFAULT 'section',
ADD COLUMN     "content" TEXT,
ADD COLUMN     "deleted_rev" INTEGER,
ADD COLUMN     "lease_holder" VARCHAR(8),
ADD COLUMN     "lease_intent" VARCHAR(200),
ADD COLUMN     "lease_task_id" UUID,
ADD COLUMN     "lease_token" VARCHAR(64),
ADD COLUMN     "lease_turn" INTEGER,
ADD COLUMN     "lease_until" TIMESTAMPTZ(6),
ADD COLUMN     "lease_user_id" UUID,
ADD COLUMN     "parent_key" VARCHAR(40),
ADD COLUMN     "pending_at" TIMESTAMPTZ(6),
ADD COLUMN     "pending_content" TEXT,
ADD COLUMN     "pending_props" JSONB,
ADD COLUMN     "pending_task_id" UUID,
ADD COLUMN     "pending_turn" INTEGER,
ADD COLUMN     "props" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "rank" TEXT,
ADD COLUMN     "rev" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "written_by_user_id" UUID;

-- AlterTable
ALTER TABLE "chat_document_versions" ADD COLUMN     "author_kind" VARCHAR(8),
ADD COLUMN     "blocks" JSONB,
ADD COLUMN     "label" VARCHAR(60),
ADD COLUMN     "named" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seq" BIGINT;

-- CreateTable
CREATE TABLE "artifact_block_revisions" (
    "artifact_id" UUID NOT NULL,
    "block_key" VARCHAR(40) NOT NULL,
    "rev" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "block_kind" VARCHAR(16) NOT NULL,
    "parent_key" VARCHAR(40),
    "rank" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT,
    "props" JSONB,
    "written_by_user_id" UUID,
    "task_id" UUID,
    "turn_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_block_revisions_pkey" PRIMARY KEY ("artifact_id","block_key","rev")
);

-- CreateTable
CREATE TABLE "artifact_batches" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "op_id" VARCHAR(64) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "answer" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_ops" (
    "artifact_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "batch_id" UUID,
    "actor" VARCHAR(8) NOT NULL,
    "user_id" UUID,
    "task_id" UUID,
    "turn_no" INTEGER,
    "kind" VARCHAR(16) NOT NULL,
    "block_key" VARCHAR(40),
    "base_rev" INTEGER,
    "new_rev" INTEGER,
    "before" JSONB,
    "result" VARCHAR(12) NOT NULL,
    "refusal" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_ops_pkey" PRIMARY KEY ("artifact_id","seq")
);

-- CreateTable
CREATE TABLE "artifact_chats" (
    "artifact_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "how" VARCHAR(12) NOT NULL,
    "first_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "artifact_chats_pkey" PRIMARY KEY ("artifact_id","task_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artifact_block_revisions_text_key" ON "artifact_block_revisions"("artifact_id", "sha256") WHERE (props IS NOT NULL);

-- CreateIndex
CREATE INDEX "artifact_batches_created_at_idx" ON "artifact_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_batches_artifact_id_op_id_key" ON "artifact_batches"("artifact_id", "op_id");

-- CreateIndex
CREATE INDEX "artifact_ops_task_id_turn_no_idx" ON "artifact_ops"("task_id", "turn_no");

-- CreateIndex
CREATE INDEX "artifact_ops_created_at_idx" ON "artifact_ops"("created_at");

-- CreateIndex
CREATE INDEX "artifact_chats_task_id_idx" ON "artifact_chats"("task_id");

-- CreateIndex
CREATE INDEX "chat_documents_project_id_idx" ON "chat_documents"("project_id");

-- CreateIndex
CREATE INDEX "chat_documents_owner_user_id_idx" ON "chat_documents"("owner_user_id");

-- CreateIndex
CREATE INDEX "chat_documents_purge_after_idx" ON "chat_documents"("purge_after");

-- CreateIndex
CREATE INDEX "chat_document_sections_document_id_state_idx" ON "chat_document_sections"("document_id", "state");

-- CreateIndex
CREATE INDEX "chat_document_sections_document_id_parent_key_rank_idx" ON "chat_document_sections"("document_id", "parent_key", "rank");

-- CreateIndex
CREATE INDEX "chat_document_sections_pending_task_id_pending_turn_idx" ON "chat_document_sections"("pending_task_id", "pending_turn");

-- AddForeignKey
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_block_revisions" ADD CONSTRAINT "artifact_block_revisions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_batches" ADD CONSTRAINT "artifact_batches_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ops" ADD CONSTRAINT "artifact_ops_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ops" ADD CONSTRAINT "artifact_ops_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "artifact_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_chats" ADD CONSTRAINT "artifact_chats_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_chats" ADD CONSTRAINT "artifact_chats_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- What an artifact says of itself. A kind is checked by its form only: a kind that left the
-- registry is still read as history (Ар7).
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_artifact_check" CHECK (
  "kind" ~ '^[a-z][a-z0-9-]{0,23}$'
  AND "seq" >= 0
  AND "bytes" >= 0
  AND (("deleted_at" IS NULL) = ("deleted_by" IS NULL))
  AND (("deleted_at" IS NULL) = ("purge_after" IS NULL))
  AND ("deleted_by" IS NULL OR "deleted_by" IN ('client', 'agent', 'project'))
  AND (("taken_down_at" IS NULL) = ("taken_down_by" IS NULL))
  AND ("taken_down_by" IS NULL OR "taken_down_by" IN ('client', 'operator'))
  AND (("pending_task_id" IS NULL) = ("pending_turn" IS NULL))
  AND (("pending_task_id" IS NULL) = ("pending_title" IS NULL))
  AND ("pending_turn" IS NULL OR "pending_turn" >= 1)
  AND ("pending_title" IS NULL OR char_length("pending_title") BETWEEN 1 AND 200)
);

-- A block is written by a turn or by a person (Ар11): `pending` has no text of its own, `written`
-- has its author — a turn or a person, never both. A heading belongs to a section only. The
-- agent's unchecked write waits in pending_* and holds the block (Ар16); a lease is a person's
-- while typing or the agent's claim (Ар17). A deleted block stays as a tombstone. `content` is not
-- bound to the state in release 1: the code before sends a checked section back to pending without
-- knowing the column (the new code clears it).
ALTER TABLE "chat_document_sections" DROP CONSTRAINT "chat_document_sections_check";
ALTER TABLE "chat_document_sections" ADD CONSTRAINT "chat_document_sections_check" CHECK (
  "section_key" ~ '^[a-z0-9][a-z0-9-]{0,39}$'
  AND "position" >= 0
  AND "state" IN ('pending', 'written')
  AND "block_kind" IN ('section', 'frame', 'html', 'style', 'script', 'note', 'settings', 'columns',
    'row', 'diagram', 'node', 'chart')
  AND "rev" >= 0
  AND ("rank" IS NULL OR "rank" ~ '^[0-9a-z]*[1-9a-z]$')
  AND ("parent_key" IS NULL
    OR ("parent_key" ~ '^[a-z0-9][a-z0-9-]{0,39}$' AND "parent_key" <> "section_key"))
  AND ("block_kind" = 'section' OR "heading" IS NULL)
  AND jsonb_typeof("props") = 'object'
  AND (
    ("state" = 'pending' AND "heading" IS NULL AND "markdown" IS NULL
      AND "written_task_id" IS NULL AND "written_turn" IS NULL AND "written_by_user_id" IS NULL
      AND "checked_turn" IS NULL)
    OR ("state" = 'written' AND "refusal" IS NULL
      AND (("written_task_id" IS NULL) = ("written_turn" IS NULL))
      AND (("written_task_id" IS NOT NULL) <> ("written_by_user_id" IS NOT NULL))
      AND ("written_turn" IS NULL OR "written_turn" >= 1)
      AND ("block_kind" <> 'section' OR "heading" IS NOT NULL)
      AND ("markdown" IS NOT NULL OR "content" IS NOT NULL)
      AND ("checked_turn" IS NULL OR "checked_turn" >= "written_turn"))
  )
  AND ("markdown" IS NULL OR octet_length("markdown") <= 32768)
  AND ("content" IS NULL OR octet_length("content") <= 204800)
  AND ("pending_content" IS NULL OR octet_length("pending_content") <= 204800)
  AND ("refusal" IS NULL OR "refusal" IN ('not_utf8', 'too_large', 'password_form', 'embedded_token', 'turn_key', 'client_value'))
  AND (("pending_task_id" IS NULL) = ("pending_turn" IS NULL))
  AND (("pending_task_id" IS NULL) = ("pending_at" IS NULL))
  AND ("pending_turn" IS NULL OR "pending_turn" >= 1)
  AND ("pending_task_id" IS NOT NULL OR ("pending_content" IS NULL AND "pending_props" IS NULL))
  AND ("pending_props" IS NULL OR jsonb_typeof("pending_props") = 'object')
  AND (("lease_holder" IS NULL) = ("lease_until" IS NULL))
  AND ("lease_holder" IS NULL OR "lease_holder" IN ('human', 'agent'))
  AND (("lease_task_id" IS NULL) = ("lease_turn" IS NULL))
  AND ("lease_turn" IS NULL OR "lease_turn" >= 1)
  AND ("lease_holder" IS DISTINCT FROM 'human' OR "lease_user_id" IS NOT NULL)
  AND ("lease_holder" IS DISTINCT FROM 'agent' OR ("lease_task_id" IS NOT NULL AND "lease_user_id" IS NULL))
  AND ("lease_holder" IS NOT NULL
    OR ("lease_user_id" IS NULL AND "lease_task_id" IS NULL AND "lease_token" IS NULL))
  AND ("lease_intent" IS NULL OR "lease_holder" = 'agent' OR "pending_task_id" IS NOT NULL)
  AND ("deleted_rev" IS NULL OR ("deleted_rev" >= 1 AND "deleted_rev" <= "rev"))
);

-- A version is up to 2 MiB now (Ар13, §7.12); a labelled one is a person's or the agent's.
ALTER TABLE "chat_document_versions" DROP CONSTRAINT "chat_document_versions_check";
ALTER TABLE "chat_document_versions" ADD CONSTRAINT "chat_document_versions_check" CHECK (
  "no" >= 1 AND "size_bytes" BETWEEN 0 AND 2097152 AND "sha256" ~ '^[0-9a-f]{64}$'
  AND ("label" IS NULL OR char_length("label") BETWEEN 1 AND 60)
  AND (NOT "named" OR "label" IS NOT NULL)
  AND ("seq" IS NULL OR "seq" >= 0)
  AND ("blocks" IS NULL OR jsonb_typeof("blocks") = 'array')
  AND ("author_kind" IS NULL OR "author_kind" IN ('user', 'turn', 'schedule'))
);
ALTER TABLE "chat_document_contents" DROP CONSTRAINT "chat_document_contents_check";
ALTER TABLE "chat_document_contents" ADD CONSTRAINT "chat_document_contents_check" CHECK (
  "version_no" >= 1 AND octet_length("markdown") <= 2097152
);

ALTER TABLE "artifact_block_revisions" ADD CONSTRAINT "artifact_block_revisions_check" CHECK (
  "rev" >= 1
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND "rank" ~ '^[0-9a-z]*[1-9a-z]$'
  AND ("content" IS NULL OR "props" IS NOT NULL)
  AND ("props" IS NULL OR jsonb_typeof("props") = 'object')
  AND (("task_id" IS NULL) = ("turn_no" IS NULL))
);

ALTER TABLE "artifact_batches" ADD CONSTRAINT "artifact_batches_check" CHECK (
  "op_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "sha256" ~ '^[0-9a-f]{64}$'
);

ALTER TABLE "artifact_ops" ADD CONSTRAINT "artifact_ops_check" CHECK (
  "seq" >= 1
  AND "actor" IN ('user', 'agent', 'schedule')
  AND ("actor" <> 'user' OR "user_id" IS NOT NULL)
  AND ("actor" = 'user' OR ("task_id" IS NOT NULL AND "turn_no" >= 1))
  AND "result" IN ('applied', 'checking', 'checked', 'refused', 'dropped', 'taken')
);

ALTER TABLE "artifact_chats" ADD CONSTRAINT "artifact_chats_check" CHECK (
  "how" IN ('created', 'attached', 'mentioned', 'edited') AND "read_seq" >= 0
);

-- The owner: the owner of the workspace (Ар11), repeatable.
UPDATE "chat_documents" AS d
SET "owner_user_id" = COALESCE(
  (SELECT m."user_id" FROM "members" m
   WHERE m."workspace_id" = d."workspace_id" AND m."role" = 'owner'
   ORDER BY m."created_at", m."id" LIMIT 1),
  (SELECT w."created_by_id" FROM "workspaces" w WHERE w."id" = d."workspace_id"))
WHERE d."owner_user_id" IS NULL;

-- The rank next to the position: a fixed width of base 36 and a closing «i», in the order the
-- reader used (position, id) — rankForIndex of @repo/db.
UPDATE "chat_document_sections" AS s
SET "rank" = substr('0123456789abcdefghijklmnopqrstuvwxyz', (o.n / 1296) % 36 + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', (o.n / 36) % 36 + 1, 1)
  || substr('0123456789abcdefghijklmnopqrstuvwxyz', o.n % 36 + 1, 1) || 'i'
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "document_id" ORDER BY "position", "id") - 1)::int AS n
  FROM "chat_document_sections"
) AS o
WHERE o."id" = s."id" AND s."rank" IS NULL;

-- The checked text in `content` (Ар11): the Markdown of the sections core checked, as it is —
-- the canonical form comes with the editor of slice 88.10. Its revision is 1.
UPDATE "chat_document_sections"
SET "content" = "markdown", "rev" = 1
WHERE "checked_turn" IS NOT NULL AND "markdown" IS NOT NULL AND "content" IS NULL;
UPDATE "chat_document_sections" SET "rev" = 1 WHERE "state" = 'written' AND "rev" = 0;

UPDATE "chat_documents" AS d
SET "bytes" = t.bytes
FROM (
  SELECT "document_id", COALESCE(SUM(octet_length("content")), 0) AS bytes
  FROM "chat_document_sections" GROUP BY "document_id"
) AS t
WHERE t."document_id" = d."id";

-- The channel of changes (Ар20, §7.4): one notification of an artifact per statement that wrote
-- its journal, the payload its id alone. PostgreSQL delivers it once the transaction committed and
-- folds the same payload of one transaction into one.
CREATE FUNCTION "raditi_artifact_signal"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('raditi_artifact', o.artifact_id::text)
  FROM (SELECT DISTINCT artifact_id FROM new_ops) AS o;
  RETURN NULL;
END $fn$;

CREATE TRIGGER "artifact_ops_signal" AFTER INSERT ON "artifact_ops"
  REFERENCING NEW TABLE AS new_ops
  FOR EACH STATEMENT EXECUTE FUNCTION "raditi_artifact_signal"();

COMMIT;
