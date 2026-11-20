-- The intent of the agent's claim is its text too (docs/plan/88-artifacts.md, Ар19, slice 88.4):
-- others may read it only once core checked it. Only adds a column with a default, no stop: the
-- code before never sets it, and an unset one shows no intent. Two indexes for the check of core,
-- which reads a chat's pending titles and claims every 1.5 s while its turn runs.

-- AlterTable
ALTER TABLE "chat_document_sections" ADD COLUMN     "lease_intent_checked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "chat_documents_pending_task_id_idx" ON "chat_documents"("pending_task_id");

-- CreateIndex
CREATE INDEX "chat_document_sections_lease_task_id_idx" ON "chat_document_sections"("lease_task_id");
