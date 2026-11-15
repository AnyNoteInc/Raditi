-- The text of every version of a document of the agent (owner's request of 14.11.2026: switch
-- between the versions of a document beside the chat). Until now only the current version kept
-- its Markdown (chat_document_contents); a version finished before this migration keeps NULL,
-- except the current one, whose text is copied here.
ALTER TABLE "chat_document_versions" ADD COLUMN "markdown" TEXT;

UPDATE "chat_document_versions" AS v
SET "markdown" = c."markdown"
FROM "chat_document_contents" AS c
WHERE c."document_id" = v."document_id" AND c."version_no" = v."no";
