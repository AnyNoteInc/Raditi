-- How the client sees a finished document of the agent (docs/plan/74-doc-live-panel.md, Д1):
-- `page` — a page to read, `text` — plain text. The documents written before are text.
ALTER TABLE "chat_documents" ADD COLUMN "view" VARCHAR(8) NOT NULL DEFAULT 'text';
ALTER TABLE "chat_documents"
  ADD CONSTRAINT "chat_documents_view_check" CHECK ("view" IN ('page', 'text'));
