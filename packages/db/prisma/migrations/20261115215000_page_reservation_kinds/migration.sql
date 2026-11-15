-- What a turn asks of the pages of its workspace (docs/plan/73-pages-sites.md, Дер23–Дер27): a
-- version (a file or a document, as before), an edit of the text, a change of the title, the
-- address or the place, a deletion to the trash, a return from it. Each is applied at the end of
-- the turn by core, which alone knows the values of the client and the keys of the turn.
--
-- Added columns only; every row of before is a version. The code before this release writes
-- versions only, which the new CHECK still takes.

BEGIN;

ALTER TABLE "page_reservations"
  ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'version',
  ADD COLUMN "payload" JSONB;

ALTER TABLE "page_reservations" DROP CONSTRAINT "page_reservations_check";
ALTER TABLE "page_reservations" ADD CONSTRAINT "page_reservations_check" CHECK (
  "kind" IN ('version', 'edit', 'update', 'delete', 'restore')
  AND ("kind" <> 'version' OR (("file_name" IS NULL) <> ("document_id" IS NULL)))
  AND ("kind" = 'version' OR ("file_name" IS NULL AND "document_id" IS NULL))
  AND ("kind" = 'version' OR "payload" IS NOT NULL)
  AND "turn_no" >= 1
  AND (("outcome" IS NULL) = ("settled_at" IS NULL))
  AND ("outcome" IS NULL OR "outcome" IN ('done', 'missing', 'refused', 'failed'))
  AND ("outcome" <> 'done' OR "kind" <> 'version' OR "version_no" IS NOT NULL)
);

COMMIT;
