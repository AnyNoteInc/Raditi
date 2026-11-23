-- Invitations to an artifact by e-mail (plan 88, Ар35, §7.1; slice 88.16-2); additive.
-- An invitation waits until a signed-in user with this confirmed address accepts it; the address
-- goes once it is accepted, declined, revoked, or 30 days have passed.
BEGIN;
CREATE TABLE "artifact_invites" (
  "id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "email" VARCHAR(320),
  "role" VARCHAR(8) NOT NULL,
  "invited_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6),
  "accepted_by" UUID,
  "closed_at" TIMESTAMPTZ(6),
  CONSTRAINT "artifact_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_invites_check" CHECK (
    "role" IN ('view', 'comment', 'edit')
    AND ("email" IS NULL OR "email" = lower("email"))
    AND ("accepted_at" IS NULL OR "closed_at" IS NULL)
  ),
  CONSTRAINT "artifact_invites_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_invites_invited_by_fkey"
    FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "artifact_invites_accepted_by_fkey"
    FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- One waiting invitation an address and artifact.
CREATE UNIQUE INDEX "artifact_invites_waiting_key" ON "artifact_invites"("artifact_id", "email")
  WHERE "accepted_at" IS NULL AND "closed_at" IS NULL;
CREATE INDEX "artifact_invites_email_idx" ON "artifact_invites"("email")
  WHERE "accepted_at" IS NULL AND "closed_at" IS NULL;
CREATE INDEX "artifact_invites_invited_by_created_at_idx" ON "artifact_invites"("invited_by", "created_at");
COMMIT;
