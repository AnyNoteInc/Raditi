-- The pictures of the diagrams in the answers of the chat (plan 91, Д3); additive. A picture is
-- kept by the SHA-256 of its engine and normalised text within its workspace: one text is drawn
-- once. An SVG the engine drew and DOMPurify cleaned (at most 512 KiB), or the error: its line for
-- people, the engine's words for operators only.
BEGIN;
CREATE TABLE "chat_diagram_renders" (
  "workspace_id" UUID NOT NULL,
  "source_sha256" CHAR(64) NOT NULL,
  "engine" VARCHAR(16) NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "svg" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "reason" VARCHAR(16),
  "error_line" INTEGER,
  "error_message" VARCHAR(300),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "chat_diagram_renders_pkey" PRIMARY KEY ("workspace_id", "source_sha256"),
  CONSTRAINT "chat_diagram_renders_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_diagram_renders_engine_check" CHECK ("engine" IN ('mermaid', 'plantuml')),
  CONSTRAINT "chat_diagram_renders_check" CHECK (
    ("ok" AND "svg" IS NOT NULL AND "width" > 0 AND "height" > 0 AND octet_length("svg") <= 524288)
    OR (NOT "ok" AND "svg" IS NULL AND "reason" IN ('parse', 'render', 'timeout', 'too_large'))
  )
);
CREATE INDEX "chat_diagram_renders_created_at_idx" ON "chat_diagram_renders"("created_at");
COMMIT;
