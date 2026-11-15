-- The trash of «Страницы» (docs/plan/73-pages-sites.md, Дер1–Дер4, §4.1): a deleted page keeps
-- its row, its versions and its bytes for 30 days and answers 410; the client returns it or it is
-- purged. Added columns only: the code before this release reads the table as it was.
ALTER TABLE pages
  ADD COLUMN deleted_at  timestamptz NULL,
  ADD COLUMN deleted_by  varchar(16) NULL,
  ADD COLUMN purge_after timestamptz NULL,
  ADD CONSTRAINT pages_trash_check CHECK (
    (deleted_at IS NULL) = (deleted_by IS NULL)
    AND (deleted_at IS NULL) = (purge_after IS NULL)
    AND (deleted_by IS NULL OR deleted_by IN ('client', 'agent')));

CREATE INDEX pages_purge_idx ON pages (purge_after) WHERE purge_after IS NOT NULL;
