-- Sites of pages (docs/plan/73-pages-sites.md, Дер11–Дер19, §4.2): a site is a host — its slug,
-- its password and the take-down of the host — and a page is a node of it at a path. Every page
-- of today becomes a site of one home page: the id of the site is the id of the page, its slug,
-- password, epoch and take-down are copied, so no address changes and the cookies of a password
-- the viewers hold stay good (their HMAC is over this id, Дер13, Дер17).
--
-- A site has no state of its own: it is in the trash when its home page is, with every page of
-- it, and its row stays after a purge as the tombstone of its slug (410 for ever, Дер2).
--
-- pages.slug and pages.password_* stay one release, read by nothing new; the release after drops
-- them (20261115120000_pages_drop_legacy, slice 73.12). The code before this release reads them
-- on its rows and finds them where they were; a page it creates in the seconds between migrate
-- and up has no tree_id and is refused (NOT NULL): its turn tells the client the page was left.
--
-- Added tables and columns, one transaction.

BEGIN;

CREATE TABLE "page_trees" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "slug" CHAR(26) NOT NULL,
    "password_hash" VARCHAR(255),
    "password_epoch" INTEGER NOT NULL DEFAULT 0,
    "taken_down_at" TIMESTAMPTZ(6),
    "taken_down_by" VARCHAR(16),
    "created_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_trees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "page_trees_check" CHECK (
      "slug" ~ '^[a-z2-7]{26}$'
      AND "password_epoch" >= 0
      AND (("taken_down_at" IS NULL) = ("taken_down_by" IS NULL))
      AND ("taken_down_by" IS NULL OR "taken_down_by" IN ('client', 'operator'))
    )
);

CREATE UNIQUE INDEX "page_trees_slug_key" ON "page_trees"("slug");
CREATE INDEX "page_trees_workspace_id_created_at_idx" ON "page_trees"("workspace_id", "created_at");

ALTER TABLE "page_trees" ADD CONSTRAINT "page_trees_workspace_id_fkey" FOREIGN KEY ("workspace_id")
  REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_trees" ADD CONSTRAINT "page_trees_created_task_id_fkey" FOREIGN KEY ("created_task_id")
  REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The host of a page of today: the page's own take-down is the host's (a page was its host).
INSERT INTO "page_trees" ("id", "workspace_id", "slug", "password_hash", "password_epoch",
    "taken_down_at", "taken_down_by", "created_task_id", "created_at", "updated_at")
  SELECT "id", "workspace_id", "slug", "password_hash", "password_epoch",
    "taken_down_at", "taken_down_by", "task_id", "created_at", "updated_at"
  FROM "pages";

ALTER TABLE "pages"
  ADD COLUMN "tree_id" UUID,
  ADD COLUMN "parent_id" UUID,
  ADD COLUMN "segment" VARCHAR(63),
  ADD COLUMN "path" VARCHAR(512) NOT NULL DEFAULT '/',
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

UPDATE "pages" SET "tree_id" = "id";
-- The take-down of the host is the site's now, and the home page keeps its own as well: the
-- release before this one reads pages.state until it stops, so a page taken down — after a
-- complaint too — answers 410 through the whole deploy. The new code clears both on «Вернуть».

ALTER TABLE "pages" ALTER COLUMN "tree_id" SET NOT NULL;
ALTER TABLE "pages" ALTER COLUMN "slug" DROP NOT NULL;

ALTER TABLE "pages" ADD CONSTRAINT "pages_tree_id_fkey" FOREIGN KEY ("tree_id")
  REFERENCES "page_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- NO ACTION, checked at the end of the statement: a purge removes a branch in one DELETE.
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_fkey" FOREIGN KEY ("parent_id")
  REFERENCES "pages"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "pages" DROP CONSTRAINT "pages_check";
ALTER TABLE "pages" ADD CONSTRAINT "pages_check" CHECK (
  ("slug" IS NULL OR "slug" ~ '^[a-z2-7]{26}$')
  AND "kind" IN ('html', 'markdown', 'doc')
  AND "state" IN ('pending', 'live', 'taken_down')
  AND "current_version" >= 0
  AND ("state" = 'pending') = ("current_version" = 0)
  AND "password_epoch" >= 0
  AND char_length("title") BETWEEN 1 AND 200
  AND (("state" = 'taken_down') = ("taken_down_at" IS NOT NULL))
  AND (("taken_down_at" IS NULL) = ("taken_down_by" IS NULL))
  AND ("taken_down_by" IS NULL OR "taken_down_by" IN ('client', 'operator'))
  AND ("turn_no" IS NULL OR "turn_no" >= 1)
);
-- A node: the home page has no parent, no segment and the path `/`; a page under it has all
-- three, its path the chain of segments (Дер15).
ALTER TABLE "pages" ADD CONSTRAINT "pages_tree_check" CHECK (
  ("parent_id" IS NULL) = ("segment" IS NULL)
  AND ("parent_id" IS NULL) = ("path" = '/')
  AND ("segment" IS NULL OR "segment" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
  AND ("path" = '/' OR "path" ~ '^(/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?){1,8}$')
  AND char_length("path") <= 512
  AND "position" >= 0
);

CREATE UNIQUE INDEX "pages_tree_path_key" ON "pages"("tree_id", "path") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "pages_tree_home_key" ON "pages"("tree_id")
  WHERE "parent_id" IS NULL AND "deleted_at" IS NULL;
CREATE INDEX "pages_tree_id_parent_id_position_idx" ON "pages"("tree_id", "parent_id", "position");

-- A former path of a page that sends on to where it is now (Дер19): no chains, one per path.
CREATE TABLE "page_redirects" (
    "tree_id" UUID NOT NULL,
    "from_path" VARCHAR(512) NOT NULL,
    "page_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_redirects_pkey" PRIMARY KEY ("tree_id", "from_path"),
    CONSTRAINT "page_redirects_check" CHECK (
      "from_path" <> '/'
      AND "from_path" ~ '^(/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?){1,8}$'
    )
);
CREATE INDEX "page_redirects_page_id_idx" ON "page_redirects"("page_id");
ALTER TABLE "page_redirects" ADD CONSTRAINT "page_redirects_tree_id_fkey" FOREIGN KEY ("tree_id")
  REFERENCES "page_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_redirects" ADD CONSTRAINT "page_redirects_page_id_fkey" FOREIGN KEY ("page_id")
  REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The Markdown a page of a `.md` was drawn from (Дер26): what page_read gives the agent back.
ALTER TABLE "page_contents" ADD COLUMN "source" BYTEA;
ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_source_check" CHECK (
  "source" IS NULL OR octet_length("source") <= 2097152
);

COMMIT;
