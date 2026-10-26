-- «Удалить проект» (owner's decision of 25.10.2026): a site the client deleted keeps its row —
-- its tasks, credit holds, ledger, releases and audit point at it and stay — and is marked
-- `deleted_at`. The cabinet no longer finds it, and its address may be added to the workspace
-- again: the address is unique among the sites that are not deleted.
--
-- A new column, empty for every row there is, and the unique index of the address made partial:
-- every row there is holds a unique address, so the new index builds over the same rows.
BEGIN;

ALTER TABLE "sites" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

DROP INDEX "sites_workspace_id_url_key";
CREATE UNIQUE INDEX "sites_workspace_id_url_key" ON "sites"("workspace_id", "url")
  WHERE "deleted_at" IS NULL;

COMMIT;
