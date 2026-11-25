-- Four kinds of artifacts stay (docs/plan/93-artifacts-trim.md, АТ1, АТ2): document, canvas,
-- slides, image. The artifacts of the six removed kinds are deleted, as the owner decided — by
-- the same path as any deletion of a client: into the trash with a term already over, so the
-- collector (`sweepArtifacts`) deletes their files and exports in S3 with their rows and keeps the
-- last content of one ever opened to others hidden 6 months (`retainPurgedArtifacts`, Ар56).
-- Their blocks stay until the collector reads them, so the CHECK of `block_kind` is not narrowed
-- here.
BEGIN;

-- One trashed with its project stops being the project's: «Вернуть» of the project returns only
-- what its `deleted_by = 'project'` names, and this artifact must not come back.
UPDATE "chat_documents"
SET "deleted_at" = COALESCE("deleted_at", now()),
    "deleted_by" = CASE WHEN "deleted_by" IN ('agent', 'client') THEN "deleted_by" ELSE 'client' END,
    "purge_after" = now(),
    "revision" = "revision" + 1
WHERE "kind" IN ('mockup', 'table', 'brand', 'diagram', 'sitemap', 'report');

-- Exports are `pdf` and `pptx` of a presentation and `png` of an image. The workbooks of tables
-- and the PDFs of reports are of artifacts the collector purges now: it deletes their rows with
-- their objects, so the narrower CHECK holds for new rows (NOT VALID) and the old ones go with it.
-- An old one with no object (pending or failed) goes now: an UPDATE of it — a job still queued
-- marking it `failed` — would break the new CHECK, and it has no file for the collector to delete.
DELETE FROM "artifact_exports"
WHERE "format" NOT IN ('pdf', 'pptx', 'png') AND "object_key" IS NULL;

ALTER TABLE "artifact_exports" DROP CONSTRAINT "artifact_exports_format_check";
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_format_check"
  CHECK ("format" IN ('pdf', 'pptx', 'png')) NOT VALID;

-- The pictures of «Схема» (88.24б): the diagrams of the chat keep their own table (plan 91).
DROP TABLE "artifact_diagram_renders";

-- The jobs to draw a picture of «Схема» nobody delivered yet: no handler is left for them.
DELETE FROM "outbox_events" WHERE "type" = 'artifact.diagram' AND "status" <> 'published';

-- Invitations to an artifact of a removed kind nobody delivered yet: the artifact is gone, and the
-- letter's word for it («макет», «таблицу», «фирменный стиль») is no longer in its schema.
DELETE FROM "outbox_events"
WHERE "type" = 'artifact.invite' AND "status" <> 'published'
  AND "payload"->>'kindWord' IN ('макет', 'таблицу', 'фирменный стиль');

COMMIT;
