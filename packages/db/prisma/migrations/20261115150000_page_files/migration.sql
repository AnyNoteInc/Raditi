-- The shared files of a site of pages (docs/plan/73-pages-sites.md, Дер34; the owner's answer to
-- В4): CSS, scripts, pictures, fonts and PDFs at /_files/… of its host, which its pages load. A
-- turn puts one from its outbox by `page_file_put`, applied at its end — a reservation of the kind
-- `asset`, which names its file as a version does. Added table and a wider CHECK only.

BEGIN;

CREATE TABLE "page_files" (
    "tree_id" UUID NOT NULL,
    "path" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_files_pkey" PRIMARY KEY ("tree_id", "path"),
    CONSTRAINT "page_files_check" CHECK (
      "path" LIKE '/\_files/%'
      AND octet_length("bytes") <= 5242880
      AND "sha256" ~ '^[0-9a-f]{64}$'
    )
);
ALTER TABLE "page_files" ADD CONSTRAINT "page_files_tree_id_fkey" FOREIGN KEY ("tree_id")
  REFERENCES "page_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_files" ADD CONSTRAINT "page_files_task_id_fkey" FOREIGN KEY ("task_id")
  REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "page_reservations" DROP CONSTRAINT "page_reservations_check";
ALTER TABLE "page_reservations" ADD CONSTRAINT "page_reservations_check" CHECK (
  "kind" IN ('version', 'edit', 'update', 'delete', 'restore', 'asset')
  AND ("kind" <> 'version' OR (("file_name" IS NULL) <> ("document_id" IS NULL)))
  AND ("kind" <> 'asset' OR ("file_name" IS NOT NULL AND "document_id" IS NULL AND "payload" IS NOT NULL))
  AND ("kind" IN ('version', 'asset') OR ("file_name" IS NULL AND "document_id" IS NULL))
  AND ("kind" = 'version' OR "payload" IS NOT NULL)
  AND "turn_no" >= 1
  AND (("outcome" IS NULL) = ("settled_at" IS NULL))
  AND ("outcome" IS NULL OR "outcome" IN ('done', 'missing', 'refused', 'failed'))
  AND ("outcome" <> 'done' OR "kind" <> 'version' OR "version_no" IS NOT NULL)
);

COMMIT;
