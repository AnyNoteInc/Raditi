-- Access of other users to an artifact (plan 88, Ар33, Ар34, §7.1; slice 88.16-1); additive.
-- A link keeps only the SHA-256 of its token; a grant is per source, so revoking a link takes only
-- its own grants away.
BEGIN;
CREATE TABLE "artifact_links" (
  "id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "role" VARCHAR(8) NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "opens" INTEGER NOT NULL DEFAULT 0,
  "last_opened_at" TIMESTAMPTZ(6),
  CONSTRAINT "artifact_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_links_check" CHECK (
    "role" IN ('view', 'comment', 'edit') AND "token_hash" ~ '^[0-9a-f]{64}$' AND "opens" >= 0
  ),
  CONSTRAINT "artifact_links_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_links_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_links_token_hash_key" ON "artifact_links"("token_hash");
-- One live link an artifact: a new one revokes the one before.
CREATE UNIQUE INDEX "artifact_links_live_key" ON "artifact_links"("artifact_id")
  WHERE "revoked_at" IS NULL;

CREATE TABLE "artifact_grants" (
  "id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "source" VARCHAR(8) NOT NULL,
  "link_id" UUID,
  "role" VARCHAR(8) NOT NULL,
  "granted_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_grants_check" CHECK (
    "role" IN ('view', 'comment', 'edit') AND "source" IN ('invite', 'link')
    AND (("source" = 'link') = ("link_id" IS NOT NULL))
  ),
  CONSTRAINT "artifact_grants_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_grants_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "artifact_links"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_grants_granted_by_fkey"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- One grant of a user per source: one by invitation, one per link.
CREATE UNIQUE INDEX "artifact_grants_invite_key"
  ON "artifact_grants"("artifact_id", "user_id") WHERE "source" = 'invite';
CREATE UNIQUE INDEX "artifact_grants_link_key"
  ON "artifact_grants"("artifact_id", "user_id", "link_id") WHERE "source" = 'link';
CREATE INDEX "artifact_grants_user_id_idx" ON "artifact_grants"("user_id");
CREATE INDEX "artifact_grants_link_id_idx" ON "artifact_grants"("link_id");
COMMIT;
