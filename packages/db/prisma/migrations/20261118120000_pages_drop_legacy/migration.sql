-- Slice 73.12, second release (docs/plan/73-pages-sites.md, §4.3): the host and the password of a
-- page live in its site since 20261115210000_page_trees; the release before this one stopped
-- reading the columns (`@ignore`), so nothing that still runs names them.
--
-- DROP COLUMN takes pages_check with it (it names "slug" and "password_epoch") and the index
-- pages_slug_key; the check is written again without those two conditions, in the same
-- transaction. deploy.sh dumps the database before migrate: the dump is the only way back.

BEGIN;

ALTER TABLE "pages" DROP CONSTRAINT "pages_check";

ALTER TABLE "pages"
  DROP COLUMN "slug",
  DROP COLUMN "password_hash",
  DROP COLUMN "password_epoch";

ALTER TABLE "pages" ADD CONSTRAINT "pages_check" CHECK (
  "kind" IN ('html', 'markdown', 'doc')
  AND "state" IN ('pending', 'live', 'taken_down')
  AND "current_version" >= 0
  AND ("state" = 'pending') = ("current_version" = 0)
  AND char_length("title") BETWEEN 1 AND 200
  AND (("state" = 'taken_down') = ("taken_down_at" IS NOT NULL))
  AND (("taken_down_at" IS NULL) = ("taken_down_by" IS NULL))
  AND ("taken_down_by" IS NULL OR "taken_down_by" IN ('client', 'operator'))
  AND ("turn_no" IS NULL OR "turn_no" >= 1)
);

COMMIT;
