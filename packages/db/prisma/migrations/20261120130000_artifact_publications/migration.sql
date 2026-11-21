-- «Опубликовать как страницу» of an artifact (docs/plan/88-artifacts.md, Ар2, §7.1, §7.10; slice
-- 88.11б): which page an artifact — or a frame of a canvas, `block_key`, from Э6 — became, and the
-- version of the artifact it shows. One row a page; only adds a table, no stop: the code before
-- never reads it, and `pages.document_id` stays for the documents of plan 69.
BEGIN;
CREATE TABLE "artifact_publications" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "block_key" VARCHAR(40),
    "page_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_publications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_publications_check" CHECK ("seq" >= 0 AND "version_no" >= 1)
);
CREATE UNIQUE INDEX "artifact_publications_page_id_key" ON "artifact_publications"("page_id");
CREATE INDEX "artifact_publications_artifact_id_idx" ON "artifact_publications"("artifact_id");
ALTER TABLE "artifact_publications" ADD CONSTRAINT "artifact_publications_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_publications" ADD CONSTRAINT "artifact_publications_page_id_fkey"
  FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
