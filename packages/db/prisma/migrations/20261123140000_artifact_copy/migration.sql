-- Whether those an artifact is opened to may make a copy of their own (plan 88, §7.8; 88.16-4).
ALTER TABLE "chat_documents" ADD COLUMN "copy_allowed" BOOLEAN NOT NULL DEFAULT false;
