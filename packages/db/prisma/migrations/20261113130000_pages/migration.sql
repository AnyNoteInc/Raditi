-- Pages, documents and publications (docs/plan/69-pages.md). A page has one address under
-- PAGES_BASE_DOMAIN (Ст10, Ст16) and lives until the client takes it down — the platform never
-- deletes one (Ст14); the bytes of its current version alone are kept (Ст16). A document is
-- written section by section through MCP, its text shown to the client only after core's check at
-- the end of the turn (Ст19). New tables only: nothing existing changes.

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "turn_no" INTEGER,
    "kind" VARCHAR(16) NOT NULL,
    "slug" CHAR(26) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "password_hash" VARCHAR(255),
    "password_epoch" INTEGER NOT NULL DEFAULT 0,
    "taken_down_at" TIMESTAMPTZ(6),
    "taken_down_by" VARCHAR(16),
    "document_id" UUID,
    "source_file_name" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "task_id" UUID,
    "turn_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_contents" (
    "page_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "page_contents_pkey" PRIMARY KEY ("page_id")
);

-- CreateTable
CREATE TABLE "page_reservations" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "file_name" VARCHAR(200),
    "document_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "outcome" VARCHAR(16),
    "version_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "page_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_documents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "finish_task_id" UUID,
    "finish_turn_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chat_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_document_sections" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "section_key" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" VARCHAR(200),
    "markdown" TEXT,
    "intent" VARCHAR(200) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "written_task_id" UUID,
    "written_turn" INTEGER,
    "checked_turn" INTEGER,
    "refusal" VARCHAR(24),

    CONSTRAINT "chat_document_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "no" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "task_id" UUID,
    "turn_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_document_contents" (
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chat_document_contents_pkey" PRIMARY KEY ("document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pages_slug_key" ON "pages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "pages_document_id_key" ON "pages"("document_id");

-- CreateIndex
CREATE INDEX "pages_workspace_id_created_at_idx" ON "pages"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "pages_task_id_idx" ON "pages"("task_id");

-- CreateIndex
CREATE INDEX "page_versions_created_at_idx" ON "page_versions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_page_id_no_key" ON "page_versions"("page_id", "no");

-- CreateIndex
CREATE INDEX "page_reservations_outcome_created_at_idx" ON "page_reservations"("outcome", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_reservations_task_id_turn_no_file_name_key" ON "page_reservations"("task_id", "turn_no", "file_name");

-- CreateIndex
CREATE UNIQUE INDEX "page_reservations_task_id_turn_no_document_id_key" ON "page_reservations"("task_id", "turn_no", "document_id");

-- CreateIndex
CREATE INDEX "chat_documents_workspace_id_created_at_idx" ON "chat_documents"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_documents_task_id_idx" ON "chat_documents"("task_id");

-- CreateIndex
CREATE INDEX "chat_document_sections_written_task_id_written_turn_idx" ON "chat_document_sections"("written_task_id", "written_turn");

CREATE INDEX "chat_document_sections_document_id_position_idx" ON "chat_document_sections"("document_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "chat_document_sections_document_id_section_key_key" ON "chat_document_sections"("document_id", "section_key");

-- CreateIndex
CREATE UNIQUE INDEX "chat_document_versions_document_id_no_key" ON "chat_document_versions"("document_id", "no");

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "chat_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_reservations" ADD CONSTRAINT "page_reservations_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document_sections" ADD CONSTRAINT "chat_document_sections_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document_versions" ADD CONSTRAINT "chat_document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_document_contents" ADD CONSTRAINT "chat_document_contents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The bytes and the Markdown kept are of a version the history names (Ст16).
CREATE UNIQUE INDEX "chat_document_contents_document_id_version_no_key" ON "chat_document_contents"("document_id", "version_no");

CREATE UNIQUE INDEX "page_contents_page_id_version_no_key" ON "page_contents"("page_id", "version_no");

ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_page_id_version_no_fkey" FOREIGN KEY ("page_id", "version_no") REFERENCES "page_versions"("page_id", "no") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_document_contents" ADD CONSTRAINT "chat_document_contents_document_id_version_no_fkey" FOREIGN KEY ("document_id", "version_no") REFERENCES "chat_document_versions"("document_id", "no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a page says of itself (Ст10, Ст13–Ст16).
ALTER TABLE "pages" ADD CONSTRAINT "pages_check" CHECK (
  "slug" ~ '^[a-z2-7]{26}$'
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

ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_check" CHECK (
  "no" >= 1
  AND "size_bytes" BETWEEN 0 AND 2097152
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND "source" IN ('outbox', 'doc', 'file')
);

-- The bytes served: pageLimits.contentBytes, the number of the current version.
ALTER TABLE "page_contents" ADD CONSTRAINT "page_contents_check" CHECK (
  "version_no" >= 1 AND octet_length("bytes") <= 2097152
);

-- A publication of a turn names a file of the outbox or a document, never both.
ALTER TABLE "page_reservations" ADD CONSTRAINT "page_reservations_check" CHECK (
  (("file_name" IS NULL) <> ("document_id" IS NULL))
  AND "turn_no" >= 1
  AND (("outcome" IS NULL) = ("settled_at" IS NULL))
  AND ("outcome" IS NULL OR "outcome" IN ('done', 'missing', 'refused', 'failed'))
  AND (("outcome" = 'done') = ("version_no" IS NOT NULL))
);

ALTER TABLE "chat_documents" ADD CONSTRAINT "chat_documents_check" CHECK (
  "revision" >= 1
  AND "current_version" >= 0
  AND char_length("title") BETWEEN 1 AND 200
  AND (("finish_task_id" IS NULL) = ("finish_turn_no" IS NULL))
  AND ("finish_turn_no" IS NULL OR "finish_turn_no" >= 1)
);

-- A pending section has no text; a written one has its heading, text and turn; only a written one
-- is checked; a refusal sends it back to pending (Ст19).
ALTER TABLE "chat_document_sections" ADD CONSTRAINT "chat_document_sections_check" CHECK (
  "section_key" ~ '^[a-z0-9][a-z0-9-]{0,39}$'
  AND "position" >= 0
  AND "state" IN ('pending', 'written')
  AND (
    ("state" = 'pending' AND "heading" IS NULL AND "markdown" IS NULL AND "written_task_id" IS NULL
      AND "written_turn" IS NULL AND "checked_turn" IS NULL)
    OR ("state" = 'written' AND "heading" IS NOT NULL AND "markdown" IS NOT NULL
      AND "written_task_id" IS NOT NULL AND "written_turn" >= 1 AND "refusal" IS NULL
      AND ("checked_turn" IS NULL OR "checked_turn" >= "written_turn"))
  )
  AND ("markdown" IS NULL OR octet_length("markdown") <= 32768)
  AND ("refusal" IS NULL OR "refusal" IN ('not_utf8', 'too_large', 'password_form', 'embedded_token', 'turn_key', 'client_value'))
);

ALTER TABLE "chat_document_versions" ADD CONSTRAINT "chat_document_versions_check" CHECK (
  "no" >= 1 AND "size_bytes" BETWEEN 0 AND 524288 AND "sha256" ~ '^[0-9a-f]{64}$'
);

ALTER TABLE "chat_document_contents" ADD CONSTRAINT "chat_document_contents_check" CHECK (
  "version_no" >= 1 AND octet_length("markdown") <= 524288
);
