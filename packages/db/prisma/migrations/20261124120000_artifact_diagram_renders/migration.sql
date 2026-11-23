-- The pictures of «Схема» (plan 88, §7.13, slice 88.24б); additive. A picture is kept by the
-- SHA-256 of the normalised text within its artifact, not by the revision of a block: the agent's
-- text waits for the check without a revision, and one key serves its draft, the checked text and
-- every version. An SVG Mermaid drew and DOMPurify cleaned (at most 512 KiB), or the error: its
-- line for people, the engine's words for the agent only.
BEGIN;
CREATE TABLE "artifact_diagram_renders" (
  "artifact_id" UUID NOT NULL,
  "source_sha256" CHAR(64) NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "svg" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "diagram_type" VARCHAR(40),
  "reason" VARCHAR(16),
  "error_line" INTEGER,
  "error_message" VARCHAR(300),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "artifact_diagram_renders_pkey" PRIMARY KEY ("artifact_id", "source_sha256"),
  CONSTRAINT "artifact_diagram_renders_artifact_id_fkey" FOREIGN KEY ("artifact_id")
    REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_diagram_renders_check" CHECK (
    ("ok" AND "svg" IS NOT NULL AND "width" > 0 AND "height" > 0 AND octet_length("svg") <= 524288)
    OR (NOT "ok" AND "svg" IS NULL AND "reason" IN ('parse', 'render', 'timeout', 'too_large'))
  )
);
CREATE INDEX "artifact_diagram_renders_created_at_idx" ON "artifact_diagram_renders"("created_at");
COMMIT;
